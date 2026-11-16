"""Suppression d'une affectation matière-classe (MatiereClasse).

Une affectation encore vierge (aucune note, aucun cours à l'emploi du temps,
aucune épreuve déposée) est supprimée directement. Une affectation déjà
utilisée est refusée (409, code « affectation_liee ») : le front affiche
alors l'historique complet de ce qui y est rattaché
(GET /api/matieres-classe/<id>/historique) et ne propose la suppression
DÉFINITIVE (DELETE ...?cascade=1, réservée à l'administrateur) qu'après une
case de confirmation.

Traçabilité : chaque ligne supprimée (notes, cours, épreuves, affectation)
est journalisée automatiquement par services/audit_services.py, dans la même
transaction. Une entrée récapitulative est ajoutée sur l'affectation
(table « matiere_classe ») : ce qui a été supprimé, en quel nombre, et le
libellé de l'affectation — retrouvable dans le Journal même après coup.
"""
from flask import current_app

from extensions import db
from models.audit_models import JournalAudit
from models.emploi_du_temps_models import Horaire
from models.epreuve_models import Epreuve
from models.evaluation_models import Note
from models.inscription_models import Eleve, Inscription
from models.pedagogie_models import Enseignant, Matiere, MatiereClasse
from models.structure_models import AnneeScolaire, Sequence

# Familles de données rattachées, dans l'ordre d'affichage.
_LIBELLES = (
    ('notes', 'note', 'notes'),
    ('horaires', "cours à l'emploi du temps", "cours à l'emploi du temps"),
    ('epreuves', 'épreuve déposée', 'épreuves déposées'),
)


def _num(valeur):
    return float(valeur) if valeur is not None else None


def _iso(dt):
    return dt.isoformat() + 'Z' if dt else None


def libelle_affectation(mc):
    classe = mc.classe
    cycle = classe.cycle.libelle if classe and getattr(classe, 'cycle', None) else ''
    option = (classe.option or '').strip() if classe else ''
    classe_txt = ' '.join(x for x in (cycle, option) if x) or f'Classe n°{mc.classe_id}'
    matiere = db.session.get(Matiere, mc.matiere_id)
    enseignant = db.session.get(Enseignant, mc.enseignant_id)
    return {
        'id': mc.id,
        'classe_id': mc.classe_id,
        'classe': classe_txt,
        'matiere': matiere.libelle if matiere else f'Matière n°{mc.matiere_id}',
        'enseignant': f'{enseignant.nom} {enseignant.prenom}'.strip() if enseignant else '—',
        'coefficient': mc.coefficient,
    }


def _collecter(mc):
    return {
        'notes': Note.query.filter_by(matiere_classe_id=mc.id).all(),
        'horaires': Horaire.query.filter_by(matiere_classe_id=mc.id).all(),
        'epreuves': Epreuve.query.filter_by(matiere_classe_id=mc.id).all(),
    }


def liens_affectation(mc):
    """{famille: nombre} des seules familles non vides ({} = affectation vierge)."""
    liens = _collecter(mc)
    return {cle: len(liens[cle]) for cle, _, _ in _LIBELLES if liens[cle]}


def _decrire(comptes):
    morceaux = [f"{comptes[cle]} {sing if comptes[cle] == 1 else plur}"
                for cle, sing, plur in _LIBELLES if comptes.get(cle)]
    if len(morceaux) > 1:
        return ', '.join(morceaux[:-1]) + ' et ' + morceaux[-1]
    return morceaux[0] if morceaux else ''


def historique_affectation(mc):
    """Tout ce qui est rattaché à l'affectation, pour la fenêtre de
    confirmation : notes (élève, séquence, valeur), cours (jour, créneau,
    salle) et épreuves (titre, fichier, date de dépôt)."""
    notes = []
    lignes = (
        db.session.query(Note, Eleve, Sequence.libelle, AnneeScolaire.libelle)
        .join(Inscription, Note.inscription_id == Inscription.id)
        .join(Eleve, Inscription.eleve_id == Eleve.id)
        .join(Sequence, Note.sequence_id == Sequence.id)
        .outerjoin(AnneeScolaire, Inscription.annee_scolaire_id == AnneeScolaire.id)
        .filter(Note.matiere_classe_id == mc.id)
        .order_by(AnneeScolaire.libelle.desc(), Sequence.id, Eleve.nom, Eleve.prenom)
        .all()
    )
    for note, eleve, sequence, annee in lignes:
        notes.append({
            'id': note.id, 'eleve': f'{eleve.nom} {eleve.prenom}'.strip(), 'matricule': eleve.matricule,
            'sequence': sequence, 'annee': annee, 'valeur': _num(note.valeur), 'absent': bool(note.absent),
            'date': _iso(note.saisie_le),
        })

    horaires = []
    ordre_jours = {j: i for i, j in enumerate(('Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'))}
    for h in sorted(Horaire.query.filter_by(matiere_classe_id=mc.id).all(),
                    key=lambda h: (ordre_jours.get(h.jour_semaine, 9),
                                   h.creneau.heure_debut.isoformat() if h.creneau and h.creneau.heure_debut else '')):
        cre = h.creneau
        horaires.append({
            'id': h.id, 'jour': h.jour_semaine, 'salle': h.salle,
            'creneau': cre.libelle if cre else None,
            'debut': cre.heure_debut.strftime('%H:%M') if cre and cre.heure_debut else None,
            'fin': cre.heure_fin.strftime('%H:%M') if cre and cre.heure_fin else None,
            'annee': h.annee_scolaire.libelle if h.annee_scolaire else None,
        })

    epreuves = [{
        'id': e.id, 'titre': e.titre, 'fichier': e.nom_original, 'date': _iso(e.created_at),
        'annee': e.annee_scolaire.libelle if e.annee_scolaire else None,
    } for e in Epreuve.query.filter_by(matiere_classe_id=mc.id).order_by(Epreuve.created_at.desc()).all()]

    return {
        'affectation': libelle_affectation(mc),
        'notes': notes,
        'horaires': horaires,
        'epreuves': epreuves,
    }


def _journaliser_recapitulatif(mc, comptes, affectation, etablissement_id):
    """Entrée de journal récapitulative, écrite dans la transaction en cours
    (même acteur que les suppressions ligne à ligne)."""
    from datetime import datetime

    from services.audit_services import _acteur

    acteur = _acteur(db.session.connection())
    changements = {
        'evenement': [None, 'Suppression définitive avec données liées'],
        'affectation': [f"{affectation['matiere']} — {affectation['classe']}", None],
        'enseignant': [affectation['enseignant'], None],
        'coefficient': [affectation['coefficient'], None],
    }
    # Nombre de lignes rattachées : [avant, après].
    for cle, _sing, _plur in _LIBELLES:
        changements[cle] = [comptes.get(cle, 0), 0]
    db.session.execute(JournalAudit.__table__.insert(), [{
        'horodatage': datetime.utcnow(),
        'action': 'suppression',
        'table_nom': 'matiere_classe',
        'ligne_id': str(mc.id),
        'version_ligne': None,
        'etablissement_id': etablissement_id if etablissement_id is not None else acteur['etablissement_id'],
        'auteur_type': acteur['auteur_type'],
        'auteur_id': acteur['auteur_id'],
        'auteur_nom': acteur['auteur_nom'],
        'auteur_role': acteur['auteur_role'],
        'adresse_ip': acteur['adresse_ip'],
        'saisi_hors_ligne_le': acteur['saisi_hors_ligne_le'],
        'changements': changements,
    }])


def supprimer_affectation(mc, etablissement_id, cascade=False):
    """Affectation vierge -> supprimée. Affectation liée -> 409 détaillé, sauf
    cascade=True (droits vérifiés par l'appelant). L'accès (établissement,
    classes assignées) est vérifié par l'appelant (get_entity_scoped)."""
    comptes = liens_affectation(mc)
    affectation = libelle_affectation(mc)
    if comptes and not cascade:
        return {
            'erreur': f"L'affectation « {affectation['matiere']} — {affectation['classe']} » est liée à "
                      f"{_decrire(comptes)}. Consultez l'historique et confirmez la suppression définitive "
                      "pour tout supprimer.",
            'code': 'affectation_liee',
            'details': comptes,
        }, 409

    fichiers = []
    try:
        if comptes:
            liens = _collecter(mc)
            fichiers = [(e.etablissement_id, e.fichier) for e in liens['epreuves']]
            for cle, _s, _p in _LIBELLES:
                for objet in liens[cle]:
                    db.session.delete(objet)
            # Les enfants partent AVANT l'affectation (ordre des DELETE).
            db.session.flush()
            _journaliser_recapitulatif(mc, comptes, affectation, etablissement_id)
        db.session.delete(mc)
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception("Échec de la suppression de l'affectation matière-classe %s", mc.id)
        return {'erreur': "Erreur lors de la suppression : rien n'a été supprimé."}, 500

    # Fichiers d'épreuves retirés du disque seulement APRÈS le commit réussi.
    if fichiers:
        from services.epreuve_services import delete_epreuve_file
        for etab_id, fichier in fichiers:
            delete_epreuve_file(etab_id, fichier)
    return {
        'message': 'Affectation supprimée' + (' avec ses données liées' if comptes else ''),
        'supprime': {cle: comptes.get(cle, 0) for cle, _s, _p in _LIBELLES},
    }, 200
