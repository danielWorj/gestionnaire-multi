"""Modes d'évaluation (Lycée, Collège, Institut) : règle UNIQUE de calcul de
la note d'une séquence à partir des notes saisies (cf.
structure_models.MODES_EVALUATION).

- Lycée : une seule note par séquence (composante 'note'), lue telle
  quelle (valeur, ou absence) — comportement historique inchangé.
- Collège / Institut : la séquence est notée par plusieurs évaluations (CC,
  DS, Ev. Tr.) ; sa note vaut Σ(poids × note) / Σ poids, une composante
  absente OU non saisie comptant 0. Tant qu'aucune composante n'est saisie,
  la séquence n'a pas de note (comme en Lycée).

Le bulletin, le procès-verbal et l'avancement de la saisie passent tous par
ici : aucune autre partie de l'application ne combine les composantes.
"""
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Optional

from models.structure_models import (
    AnneeScolaire, Sequence, Trimestre, MODES_EVALUATION, MODE_EVALUATION_DEFAUT,
    MODELES_BULLETIN, MODELES_BULLETIN_DEFAUT,
)


def mode_valide(mode):
    return mode in MODES_EVALUATION


def normaliser_mode(mode):
    return mode if mode_valide(mode) else MODE_EVALUATION_DEFAUT


def composantes(mode):
    """[(code, libellé, poids)] du mode."""
    return MODES_EVALUATION[normaliser_mode(mode)]['composantes']


def codes_composantes(mode):
    return [code for code, _libelle, _poids in composantes(mode)]


def est_compose(mode):
    """Vrai pour les modes où une séquence a plusieurs évaluations."""
    return len(composantes(mode)) > 1


def description_modes():
    """Liste servie au client (formulaires, saisie)."""
    return [
        {'code': code, 'libelle': m['libelle'],
         'composantes': [{'code': c, 'libelle': l, 'poids': p} for c, l, p in m['composantes']]}
        for code, m in MODES_EVALUATION.items()
    ]


def modele_bulletin_compatible(code, mode):
    """Vrai si le modèle de bulletin `code` appartient au mode d'évaluation."""
    return code in MODELES_BULLETIN and normaliser_mode(mode) in MODELES_BULLETIN[code]['modes']


def modeles_bulletin_du_mode(mode):
    return [code for code in MODELES_BULLETIN if modele_bulletin_compatible(code, mode)]


def modele_bulletin_defaut(mode):
    return MODELES_BULLETIN_DEFAUT[normaliser_mode(mode)]


def modele_bulletin_effectif(code, mode):
    """Modèle utilisé pour imprimer une année de ce mode : celui de
    l'établissement s'il appartient au mode, sinon le modèle par défaut du mode."""
    code = code if modele_bulletin_compatible(code, mode) else modele_bulletin_defaut(mode)
    return {'code': code, 'extremes': False, 'colonne_note': False, **MODELES_BULLETIN[code]}


def mode_de_annee(annee):
    return normaliser_mode(annee.mode_evaluation if annee else None)


def mode_de_sequence(sequence):
    return mode_de_annee(sequence.trimestre.annee_scolaire if sequence else None)


def annee_de_sequence_id(sequence_id):
    return (AnneeScolaire.query
            .join(Trimestre, Trimestre.annee_scolaire_id == AnneeScolaire.id)
            .join(Sequence, Sequence.trimestre_id == Trimestre.id)
            .filter(Sequence.id == sequence_id)
            .first())


@dataclass
class NoteSequence:
    """Note d'un élève, pour une matière-classe et une séquence.

    valeur/absent : mêmes attributs qu'une ligne Note (le procès-verbal et
    le bulletin les lisent sans connaître le mode). composantes : {code:
    Decimal | 'ABS' | None} (vide en mode Lycée), pour l'affichage."""
    valeur: Optional[Decimal]
    absent: bool
    composantes: dict = field(default_factory=dict)


def _saisie(ligne):
    return ligne is not None and (ligne.valeur is not None or bool(ligne.absent))


def notes_par_sequence(lignes, mode):
    """Lignes Note (d'une même année) -> {(inscription_id, matiere_classe_id,
    sequence_id): NoteSequence}. Une séquence sans aucune note saisie
    n'apparaît pas. Les composantes étrangères au mode sont ignorées."""
    mode = normaliser_mode(mode)
    codes = composantes(mode)
    groupes = {}
    for n in lignes:
        groupes.setdefault((n.inscription_id, n.matiere_classe_id, n.sequence_id), {})[n.composante or 'note'] = n

    resultat = {}
    for cle, par_code in groupes.items():
        if not est_compose(mode):
            ligne = par_code.get('note')
            if _saisie(ligne):
                resultat[cle] = NoteSequence(
                    valeur=Decimal(str(ligne.valeur)) if ligne.valeur is not None else None,
                    absent=bool(ligne.absent) and ligne.valeur is None,
                )
            continue

        if not any(_saisie(par_code.get(code)) for code, _l, _p in codes):
            continue
        detail, points, poids_total = {}, Decimal('0'), 0
        for code, _libelle, poids in codes:
            ligne = par_code.get(code)
            if ligne is not None and ligne.valeur is not None:
                valeur = Decimal(str(ligne.valeur))
                detail[code] = valeur
                points += valeur * poids
            else:
                detail[code] = 'ABS' if ligne is not None and ligne.absent else None
            poids_total += poids
        resultat[cle] = NoteSequence(valeur=points / Decimal(poids_total), absent=False, composantes=detail)
    return resultat
