"""Espace parent : situation de chaque enfant (scolarité, paiements,
bulletins) vue par sa famille, et règle de blocage du bulletin.

Règle du bulletin grisé : le bulletin d'un élève est SUSPENDU dans l'espace
parent tant qu'une tranche EXIGIBLE de son échéancier (date limite passée,
ou tranche sans date limite — cf. paiements_services.tranche_exigible) reste
impayée, sauf si l'administration a levé ce blocage pour l'élève
(Inscription.bulletin_debloque). Une tranche dont la date limite n'est pas
encore passée ne bloque jamais rien.

Ce blocage ne concerne QUE l'espace parent : l'établissement continue de
consulter et d'imprimer tous les bulletins (pages Bulletins).

Bulletins publiés : une famille ne voit que les bulletins des périodes
TERMINÉES (date de fin de la séquence passée ; pour un trimestre ou
l'annuel, toutes leurs séquences terminées). Une période en cours n'est pas
proposée : ses notes sont encore en cours de saisie.
"""
from datetime import date

from sqlalchemy import func

from extensions import db
from models.inscription_models import Eleve, Inscription
from models.paiements_models import LignePaiement, Paiement, TrancheClasse
from models.structure_models import annee_active
from services.bulletin_services import classe_label, periodes_disponibles, sequences_annee
from services.paiements_services import tranche_exigible

MOTIF_BULLETIN_BLOQUE = ("Le bulletin sera disponible dès le règlement des frais de scolarité échus. "
                         "Rapprochez-vous de l'économat de l'établissement.")


def _r2(x):
    return round(float(x or 0), 2)


# ---------------------------------------------------------------------------
# Situation financière
# ---------------------------------------------------------------------------

def situations_paiement(inscriptions, aujourdhui=None):
    """{inscription_id: situation} en trois requêtes, quel que soit le
    nombre d'inscriptions. Seuls les paiements VALIDES comptent ; le versé
    d'une tranche est plafonné à son montant (un trop-versé n'en rembourse
    pas une autre, même règle que le rapport de solvabilité).

    situation = {tranches: [{tranche_classe_id, libelle, ordre,
                 montant_attendu, date_limite, montant_verse, reste_du,
                 exigible, en_retard}],
                 total_attendu, total_verse, reste_annuel, impaye_exigible,
                 en_retard (bool), prochaine_echeance ({libelle, date_limite,
                 reste_du} | None), a_echeancier (bool)}"""
    aujourdhui = aujourdhui or date.today()
    inscriptions = list(inscriptions)
    if not inscriptions:
        return {}

    couples = {(i.classe_id, i.annee_scolaire_id) for i in inscriptions}
    tranches_par_couple = {}
    for t in (TrancheClasse.query
              .filter(TrancheClasse.classe_id.in_({c for c, _ in couples}),
                      TrancheClasse.annee_scolaire_id.in_({a for _, a in couples}))
              .order_by(TrancheClasse.ordre).all()):
        tranches_par_couple.setdefault((t.classe_id, t.annee_scolaire_id), []).append(t)

    verse = {}
    for insc_id, tranche_id, montant in (
        db.session.query(Paiement.inscription_id, LignePaiement.tranche_classe_id,
                         func.sum(LignePaiement.montant_verse))
        .join(Paiement, Paiement.id == LignePaiement.paiement_id)
        .filter(Paiement.inscription_id.in_([i.id for i in inscriptions]), Paiement.statut == 'VALIDE')
        .group_by(Paiement.inscription_id, LignePaiement.tranche_classe_id)
        .all()
    ):
        verse[(insc_id, tranche_id)] = float(montant or 0)

    resultat = {}
    for insc in inscriptions:
        detail = []
        attendu = verse_total = impaye = 0.0
        prochaine = None
        for t in tranches_par_couple.get((insc.classe_id, insc.annee_scolaire_id), []):
            montant = float(t.montant_attendu)
            paye = min(verse.get((insc.id, t.id), 0.0), montant)
            reste = round(montant - paye, 2)
            exigible = tranche_exigible(t.date_limite, aujourdhui)
            en_retard = exigible and reste > 0
            attendu += montant
            verse_total += paye
            if en_retard:
                impaye += reste
            elif reste > 0 and prochaine is None:
                prochaine = {"libelle": t.libelle, "date_limite": t.date_limite.isoformat(), "reste_du": reste}
            detail.append({
                "tranche_classe_id": t.id,
                "libelle": t.libelle,
                "ordre": t.ordre,
                "montant_attendu": _r2(montant),
                "date_limite": t.date_limite.isoformat() if t.date_limite else None,
                "montant_verse": _r2(paye),
                "reste_du": reste,
                "exigible": exigible,
                "en_retard": en_retard,
            })
        resultat[insc.id] = {
            "tranches": detail,
            "a_echeancier": bool(detail),
            "total_attendu": _r2(attendu),
            "total_verse": _r2(verse_total),
            "reste_annuel": _r2(attendu - verse_total),
            "impaye_exigible": _r2(impaye),
            "en_retard": impaye > 0,
            "prochaine_echeance": prochaine,
        }
    return resultat


def etat_bulletin(inscription, situation):
    """{bloque, debloque_par_admin, motif} pour l'espace parent."""
    impaye = bool(situation and situation["en_retard"])
    bloque = impaye and not inscription.bulletin_debloque
    return {
        "bloque": bloque,
        "debloque_par_admin": impaye and bool(inscription.bulletin_debloque),
        "motif": MOTIF_BULLETIN_BLOQUE if bloque else None,
    }


# ---------------------------------------------------------------------------
# Périodes publiées
# ---------------------------------------------------------------------------

def _terminee(sequences, aujourdhui):
    return bool(sequences) and all(s.date_fin is not None and s.date_fin < aujourdhui for s in sequences)


def periodes_publiees(annee_id, aujourdhui=None):
    """Périodes de periodes_disponibles() dont toutes les séquences sont
    terminées (cf. docstring du module), dans le même ordre et format."""
    aujourdhui = aujourdhui or date.today()
    sequences = sequences_annee(annee_id)
    par_id = {s.id: s for s in sequences}
    publiees = []
    for p in periodes_disponibles(annee_id):
        genre, _, ident = p["value"].partition(':')
        if genre == 'seq':
            membres = [par_id[int(ident)]]
        elif genre == 'tri':
            membres = [s for s in sequences if s.trimestre_id == int(ident)]
        else:
            membres = sequences
        if _terminee(membres, aujourdhui):
            publiees.append(p)
    return publiees


# ---------------------------------------------------------------------------
# Enfants d'une famille
# ---------------------------------------------------------------------------

def inscription_courante(eleve, annee):
    """Inscription de l'élève sur l'année donnée (une seule par année, cf.
    inscription_services._valider_inscription_unique), ou None."""
    if annee is None:
        return None
    return Inscription.query.filter_by(eleve_id=eleve.id, annee_scolaire_id=annee.id).first()


def enfant_du_parent(parent, eleve_id):
    """L'élève s'il est bien rattaché à ce parent, sinon None (sans
    distinguer « inexistant » et « enfant d'une autre famille »)."""
    eleve = db.session.get(Eleve, eleve_id) if eleve_id else None
    if not eleve or eleve.parent_id != parent.id or eleve.etablissement_id != parent.etablissement_id:
        return None
    return eleve


def suivi_enfants(parent, aujourdhui=None):
    """Situation de chacun des enfants du parent sur l'année active de
    l'établissement : identité, classe, paiements (échéancier + versements),
    état du bulletin. Partagé par l'espace parent et la fiche famille du
    secrétariat (même information des deux côtés du guichet)."""
    aujourdhui = aujourdhui or date.today()
    annee = annee_active(parent.etablissement_id)
    eleves = sorted(parent.enfants, key=lambda e: ((e.prenom or '').upper(), (e.nom or '').upper()))
    inscriptions = {e.id: inscription_courante(e, annee) for e in eleves}
    situations = situations_paiement([i for i in inscriptions.values() if i], aujourdhui)

    versements = {}
    ids = [i.id for i in inscriptions.values() if i]
    if ids:
        for p in (Paiement.query.filter(Paiement.inscription_id.in_(ids), Paiement.statut == 'VALIDE')
                  .order_by(Paiement.date_paiement.desc()).all()):
            versements.setdefault(p.inscription_id, []).append({
                "id": p.id,
                "numero_recu": p.numero_recu,
                "date_paiement": p.date_paiement.isoformat() + 'Z',
                "montant": _r2(p.montant_total),
                "mode_paiement": p.mode_paiement,
            })

    publiees = periodes_publiees(annee.id, aujourdhui) if annee else []
    enfants = []
    for e in eleves:
        insc = inscriptions[e.id]
        situation = situations.get(insc.id) if insc else None
        enfants.append({
            "eleve": {
                "id": e.id, "matricule": e.matricule, "nom": e.nom, "prenom": e.prenom, "sexe": e.sexe,
                "a_photo": bool(e.photo),
            },
            "inscription": ({
                "id": insc.id,
                "classe_id": insc.classe_id,
                "classe": classe_label(insc.classe),
                "statut": insc.statut,
                "bulletin_debloque": bool(insc.bulletin_debloque),
            } if insc else None),
            "paiements": situation,
            "versements": versements.get(insc.id, []) if insc else [],
            "bulletin": ({**etat_bulletin(insc, situation), "periodes": publiees} if insc else None),
        })
    return {
        "annee_scolaire": {"id": annee.id, "libelle": annee.libelle} if annee else None,
        "enfants": enfants,
    }


def contexte_bulletin(parent, eleve_id, periode, aujourdhui=None):
    """Vérifie qu'un parent peut ouvrir le bulletin de cet enfant pour
    cette période. Retourne ((inscription, annee), None) ou (None, (erreur,
    status)) — 403 'bulletin_bloque' si des frais échus restent impayés."""
    aujourdhui = aujourdhui or date.today()
    eleve = enfant_du_parent(parent, eleve_id)
    if eleve is None:
        return None, ({"erreur": "Élève introuvable"}, 404)
    annee = annee_active(parent.etablissement_id)
    insc = inscription_courante(eleve, annee)
    if insc is None:
        return None, ({"erreur": "Cet élève n'est pas inscrit pour l'année en cours"}, 404)
    if periode not in {p["value"] for p in periodes_publiees(annee.id, aujourdhui)}:
        return None, ({"erreur": "Ce bulletin n'est pas encore disponible : la période n'est pas terminée"}, 404)
    situation = situations_paiement([insc], aujourdhui).get(insc.id)
    if etat_bulletin(insc, situation)["bloque"]:
        return None, ({"erreur": MOTIF_BULLETIN_BLOQUE, "code": "bulletin_bloque"}, 403)
    return (insc, annee), None

