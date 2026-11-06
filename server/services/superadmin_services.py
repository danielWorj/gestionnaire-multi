"""Supervision de la plateforme par le SuperAdmin (cf. api/superadmin_api.py).

- vue_reseau()        : indicateurs de CHAQUE établissement (effectifs,
                        finances, avancement des notes, activité, alertes)
                        et totaux du réseau, calculés en direct.
- comptes SuperAdmin  : liste, création, modification, réinitialisation du
                        mot de passe. Le mot de passe est toujours généré
                        par le serveur et renvoyé UNE seule fois.

Les chiffres reposent sur les RÈGLES COMMUNES de l'application, pour être
identiques à ceux des autres écrans : année de référence
(structure_models.annee_active), séquence courante
(structure_models.sequence_courante), effectif d'une classe
(structure_models.effectifs_classes : inscriptions en cours) et notes saisies
(evaluation_services.notes_saisies_par_mc).
"""
import secrets
from datetime import datetime, timedelta

from flask import current_app
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from extensions import db
from models.audit_models import JournalAudit
from models.authentification_models import (
    Role, SessionConnexion, SuperAdmin, Utilisateur, utilisateur_role, valider_force_mot_de_passe,
)
from models.inscription_models import STATUTS_INSCRIPTION_EN_COURS, Eleve, Inscription
from models.paiements_models import LignePaiement, Paiement, TrancheClasse
from models.pedagogie_models import Enseignant, MatiereClasse
from models.structure_models import Classe, Etablissement, annee_active, effectifs_classes, sequence_courante
from services.evaluation_services import notes_saisies_par_mc

# Au-delà, un établissement sans aucune modification enregistrée est signalé
# (seulement si le journal existe depuis au moins aussi longtemps).
JOURS_SANS_ACTIVITE = 14
JOURS_ACTIVITE = 14


def _maintenant():
    return datetime.utcnow()


# ============================================================================
# VUE RÉSEAU
# ============================================================================

def _decalage():
    """Heure locale des établissements = UTC + décalage (config.py)."""
    return timedelta(hours=current_app.config.get('DECALAGE_HORAIRE_HEURES', 1))


def _jours_locaux():
    """Les JOURS_ACTIVITE derniers jours LOCAUX : [(jour, début UTC, fin UTC)]."""
    decalage = _decalage()
    aujourd_hui = (_maintenant() + decalage).date()
    jours = []
    for i in range(JOURS_ACTIVITE - 1, -1, -1):
        jour = aujourd_hui - timedelta(days=i)
        debut = datetime.combine(jour, datetime.min.time()) - decalage
        jours.append((jour, debut, debut + timedelta(days=1)))
    return jours


def _finances(etab_id, annee, effectifs):
    """(attendu, encaissé) de l'année : échéancier de chaque classe multiplié
    par son effectif (inscriptions en cours), et lignes des paiements valides."""
    if not annee:
        return 0.0, 0.0
    du_par_classe = dict(
        db.session.query(TrancheClasse.classe_id, func.sum(TrancheClasse.montant_attendu))
        .join(Classe, Classe.id == TrancheClasse.classe_id)
        .filter(TrancheClasse.annee_scolaire_id == annee.id, Classe.etablissement_id == etab_id)
        .group_by(TrancheClasse.classe_id).all()
    )
    attendu = sum(float(du_par_classe.get(c, 0) or 0) * n for c, n in effectifs.items())
    encaisse = (db.session.query(func.coalesce(func.sum(LignePaiement.montant_verse), 0))
                .join(Paiement, LignePaiement.paiement_id == Paiement.id)
                .join(Inscription, Paiement.inscription_id == Inscription.id)
                .join(Classe, Classe.id == Inscription.classe_id)
                .filter(Inscription.annee_scolaire_id == annee.id, Classe.etablissement_id == etab_id,
                        Paiement.statut == 'VALIDE')
                .scalar())
    return attendu, float(encaisse or 0)


def _avancement_notes(etab_id, annee, sequence, effectifs):
    """(notes saisies, notes attendues) pour la séquence courante — même
    calcul que les cartes de classes de l'espace Censeur : une note par élève
    de l'effectif et par matière de sa classe, les saisies d'une matière
    plafonnées à l'effectif."""
    if not annee or not sequence:
        return 0, 0
    liens = (db.session.query(MatiereClasse.id, MatiereClasse.classe_id)
             .join(Classe, Classe.id == MatiereClasse.classe_id)
             .filter(Classe.etablissement_id == etab_id).all())
    saisies_par_mc = notes_saisies_par_mc([mc_id for mc_id, _ in liens], sequence, annee)
    saisies = sum(min(saisies_par_mc.get(mc_id, 0), effectifs.get(classe_id, 0)) for mc_id, classe_id in liens)
    attendues = sum(effectifs.get(classe_id, 0) for _, classe_id in liens)
    return saisies, attendues


def _comptes(etab_id):
    actifs = Utilisateur.query.filter_by(etablissement_id=etab_id, actif=True)
    admins = actifs.filter(Utilisateur.roles.any(Role.libelle == 'Admin')).count()
    verrouilles = actifs.filter(Utilisateur.verrouille_jusqua > _maintenant()).count()
    return {'actifs': actifs.count(), 'admins_actifs': admins, 'verrouilles': verrouilles}


def _activite(etab_id, depuis):
    base = JournalAudit.query.filter(JournalAudit.etablissement_id == etab_id)
    derniere = base.with_entities(func.max(JournalAudit.horodatage)).scalar()
    recentes = base.filter(JournalAudit.horodatage >= depuis).count()
    hors_ligne = base.filter(JournalAudit.horodatage >= depuis,
                             JournalAudit.saisi_hors_ligne_le.isnot(None)).count()
    return derniere, recentes, hors_ligne


def _alertes(ligne, journal_depuis):
    alertes = []
    if ligne['comptes']['admins_actifs'] == 0:
        alertes.append({'niveau': 'danger', 'code': 'sans_admin', 'message': "Aucun administrateur actif"})
    if not ligne['annee']:
        alertes.append({'niveau': 'danger', 'code': 'sans_annee', 'message': "Aucune année scolaire configurée"})
    elif not ligne['annee']['active']:
        alertes.append({'niveau': 'warning', 'code': 'annee_inactive', 'message': "Aucune année scolaire marquée active"})
    elif ligne['effectifs']['classes'] == 0:
        alertes.append({'niveau': 'warning', 'code': 'sans_classe', 'message': "Aucune classe créée"})
    elif ligne['finances']['attendu'] == 0 and ligne['effectifs']['inscrits'] > 0:
        alertes.append({'niveau': 'warning', 'code': 'sans_echeancier', 'message': "Aucun échéancier de paiement"})
    if ligne['comptes']['verrouilles']:
        n = ligne['comptes']['verrouilles']
        alertes.append({'niveau': 'warning', 'code': 'comptes_bloques',
                        'message': f"{n} compte{'s' if n > 1 else ''} bloqué{'s' if n > 1 else ''} (PIN faux)"})
    # Inactivité : signalée seulement si le journal a au moins JOURS_SANS_ACTIVITE
    # jours d'historique (sinon, juste après sa mise en service, tous les
    # établissements seraient signalés à tort).
    seuil = _maintenant() - timedelta(days=JOURS_SANS_ACTIVITE)
    derniere = ligne['activite']['derniere']
    if journal_depuis and journal_depuis <= seuil and (not derniere or datetime.fromisoformat(derniere) < seuil):
        alertes.append({'niveau': 'info', 'code': 'inactif',
                        'message': f"Aucune activité depuis plus de {JOURS_SANS_ACTIVITE} jours"})
    return alertes


def _ligne_etablissement(etab, depuis, journal_depuis):
    annee = annee_active(etab.id)
    sequence = sequence_courante(annee)
    effectifs = effectifs_classes(etab.id, None, annee.id) if annee else {}
    filles = (Inscription.query.join(Eleve, Inscription.eleve_id == Eleve.id)
              .join(Classe, Classe.id == Inscription.classe_id)
              .filter(Inscription.annee_scolaire_id == annee.id, Classe.etablissement_id == etab.id,
                      Inscription.statut.in_(STATUTS_INSCRIPTION_EN_COURS), Eleve.sexe == 'F').count()
              if annee else 0)
    attendu, encaisse = _finances(etab.id, annee, effectifs)
    saisies, attendues = _avancement_notes(etab.id, annee, sequence, effectifs)
    derniere, recentes, hors_ligne = _activite(etab.id, depuis)

    ligne = {
        'id': etab.id,
        'nom': etab.nom,
        'code': etab.code,
        'region': etab.region,
        'logo': etab.logo,
        'annee': {'id': annee.id, 'libelle': annee.libelle, 'active': bool(annee.active)} if annee else None,
        'sequence': {'id': sequence.id, 'libelle': sequence.libelle} if sequence else None,
        'effectifs': {
            'inscrits': sum(effectifs.values()),
            'filles': filles,
            'classes': Classe.query.filter_by(etablissement_id=etab.id).count(),
            'enseignants': Enseignant.query.filter_by(etablissement_id=etab.id).count(),
        },
        'finances': {
            'attendu': round(attendu, 2),
            'encaisse': round(encaisse, 2),
            'taux': round(100 * encaisse / attendu, 1) if attendu else None,
        },
        'notes': {
            'saisies': saisies,
            'attendues': attendues,
            'taux': round(100 * saisies / attendues, 1) if attendues else None,
        },
        'comptes': _comptes(etab.id),
        'activite': {
            'derniere': derniere.isoformat() if derniere else None,
            'modifications': recentes,
            'hors_ligne': hors_ligne,
        },
    }
    ligne['alertes'] = _alertes(ligne, journal_depuis)
    return ligne


def _serie_activite(jours):
    """Modifications par jour LOCAL sur tout le réseau (jours sans activité
    inclus, à 0)."""
    return [{'jour': jour.isoformat(),
             'modifications': JournalAudit.query.filter(JournalAudit.horodatage >= debut,
                                                        JournalAudit.horodatage < fin).count()}
            for jour, debut, fin in jours]


def vue_reseau():
    jours = _jours_locaux()
    depuis = jours[0][1]
    journal_depuis = db.session.query(func.min(JournalAudit.horodatage)).scalar()
    lignes = [_ligne_etablissement(e, depuis, journal_depuis)
              for e in Etablissement.query.order_by(Etablissement.nom).all()]

    attendu = sum(l['finances']['attendu'] for l in lignes)
    encaisse = sum(l['finances']['encaisse'] for l in lignes)
    saisies = sum(l['notes']['saisies'] for l in lignes)
    attendues = sum(l['notes']['attendues'] for l in lignes)
    comptes_par_role = dict(
        db.session.query(Role.libelle, func.count(func.distinct(Utilisateur.id)))
        .join(utilisateur_role, utilisateur_role.c.role_id == Role.id)
        .join(Utilisateur, Utilisateur.id == utilisateur_role.c.utilisateur_id)
        .filter(Utilisateur.actif.is_(True)).group_by(Role.libelle).all()
    )

    return {
        'genere_le': _maintenant().isoformat(),
        'jours_activite': JOURS_ACTIVITE,
        'totaux': {
            'etablissements': len(lignes),
            'inscrits': sum(l['effectifs']['inscrits'] for l in lignes),
            'filles': sum(l['effectifs']['filles'] for l in lignes),
            'classes': sum(l['effectifs']['classes'] for l in lignes),
            'enseignants': sum(l['effectifs']['enseignants'] for l in lignes),
            'comptes_actifs': sum(l['comptes']['actifs'] for l in lignes),
            'comptes_bloques': sum(l['comptes']['verrouilles'] for l in lignes),
            'comptes_par_role': comptes_par_role,
            'attendu': round(attendu, 2),
            'encaisse': round(encaisse, 2),
            'taux_recouvrement': round(100 * encaisse / attendu, 1) if attendu else None,
            'notes_saisies': saisies,
            'notes_attendues': attendues,
            'taux_notes': round(100 * saisies / attendues, 1) if attendues else None,
            'modifications': sum(l['activite']['modifications'] for l in lignes),
            'hors_ligne': sum(l['activite']['hors_ligne'] for l in lignes),
            'alertes': sum(1 for l in lignes for a in l['alertes'] if a['niveau'] != 'info'),
        },
        'activite': _serie_activite(jours),
        'etablissements': lignes,
    }


# ============================================================================
# COMPTES SUPERADMIN
# ============================================================================

def generer_mot_de_passe(longueur=12):
    """Mot de passe aléatoire conforme à valider_force_mot_de_passe (lettres
    ET chiffres), sans caractères ambigus à la lecture."""
    lettres = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ'
    chiffres = '23456789'
    while True:
        mdp = ''.join(secrets.choice(lettres + chiffres) for _ in range(longueur))
        if any(c in lettres for c in mdp) and any(c in chiffres for c in mdp) and valider_force_mot_de_passe(mdp)[0]:
            return mdp


def _email(valeur):
    email = (valeur or '').strip().lower()
    return email if email and '@' in email and '.' in email.split('@')[-1] else None


def _actifs_restants(sauf_id):
    return SuperAdmin.query.filter(SuperAdmin.actif.is_(True), SuperAdmin.id != sauf_id).count()


def lister_superadmins():
    return [s.to_dict() for s in SuperAdmin.query.order_by(SuperAdmin.actif.desc(), SuperAdmin.nom).all()]


def creer_superadmin(data):
    nom = (data.get('nom') or '').strip()
    email = _email(data.get('email'))
    if not nom:
        return {"erreur": "Le nom est requis"}, 400
    if not email:
        return {"erreur": "Email invalide"}, 400
    if SuperAdmin.query.filter(func.lower(SuperAdmin.email) == email).first():
        return {"erreur": "Un compte SuperAdmin utilise déjà cet email"}, 409

    mot_de_passe = generer_mot_de_passe()
    compte = SuperAdmin(nom=nom, email=email, actif=True)
    compte.set_password(mot_de_passe)
    db.session.add(compte)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return {"erreur": "Un compte SuperAdmin utilise déjà cet email"}, 409
    return {**compte.to_dict(), 'mot_de_passe': mot_de_passe}, 201


def modifier_superadmin(compte_id, data, courant_id):
    compte = db.session.get(SuperAdmin, compte_id)
    if not compte:
        return {"erreur": "Compte SuperAdmin introuvable"}, 404

    if 'nom' in data:
        nom = (data.get('nom') or '').strip()
        if not nom:
            return {"erreur": "Le nom est requis"}, 400
        compte.nom = nom
    if 'email' in data:
        email = _email(data.get('email'))
        if not email:
            return {"erreur": "Email invalide"}, 400
        if SuperAdmin.query.filter(func.lower(SuperAdmin.email) == email, SuperAdmin.id != compte.id).first():
            return {"erreur": "Un compte SuperAdmin utilise déjà cet email"}, 409
        compte.email = email
    if 'actif' in data:
        actif = bool(data['actif'])
        if not actif:
            if compte.id == courant_id:
                return {"erreur": "Vous ne pouvez pas désactiver votre propre compte"}, 400
            if compte.actif and _actifs_restants(compte.id) == 0:
                return {"erreur": "Impossible : c'est le dernier compte SuperAdmin actif"}, 400
            SessionConnexion.fermer_toutes('superadmin', compte.id)
        compte.actif = actif

    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return {"erreur": "Un compte SuperAdmin utilise déjà cet email"}, 409
    return compte.to_dict(), 200


def reinitialiser_mdp_superadmin(compte_id, courant_id):
    compte = db.session.get(SuperAdmin, compte_id)
    if not compte:
        return {"erreur": "Compte SuperAdmin introuvable"}, 404
    if compte.id == courant_id:
        return {"erreur": "Pour votre propre compte, utilisez « Changer le mot de passe »"}, 400
    mot_de_passe = generer_mot_de_passe()
    compte.set_password(mot_de_passe)
    SessionConnexion.fermer_toutes('superadmin', compte.id)
    db.session.commit()
    return {**compte.to_dict(), 'mot_de_passe': mot_de_passe}, 200
