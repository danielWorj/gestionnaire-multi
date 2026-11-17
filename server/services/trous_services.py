"""Notes manquantes (« trous ») d'une classe sur une période, et dispenses.

Avant de générer un bulletin ou un procès-verbal, l'interface présente la
liste des élèves et des matières où une note manque. Pour chaque trou, le
titulaire, le censeur, l'Admin ou le SuperAdmin peut :
  - saisir la note manquante (POST /api/trous/note) ;
  - dispenser l'élève de la matière sur la séquence (coefficient annulé,
    POST /api/trous/dispense) : elle ne compte plus ni dans ses points ni
    dans ses coefficients.

Périodes (même syntaxe que les bulletins et les procès-verbaux) :
  seq:<id>              une séquence (toutes ses évaluations en
                        Collège/Institut : la note de la séquence) ;
  seq:<id>:<composante> une seule évaluation (cc, ds, evtr) d'une séquence ;
  tri:<id>              les séquences d'un trimestre ;
  annuel                toutes les séquences de l'année.
"""
import re
from datetime import datetime

from extensions import db
from models.evaluation_models import Dispense, Note
from models.inscription_models import Inscription, STATUTS_INSCRIPTION_EN_COURS
from models.pedagogie_models import MatiereClasse
from models.structure_models import AnneeScolaire, Classe, Sequence, sequences_de_annee
from services.mode_evaluation_services import codes_composantes, composantes, mode_de_annee


class PeriodeErreur(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def _numero(sequence):
    trouve = re.search(r'(\d+)\s*$', sequence.libelle or '')
    return trouve.group(1) if trouve else None


def resoudre_periode(periode, annee):
    """-> dict {type: sequence|evaluation|trimestre|annuel, sequences,
    composante (code ou None), titre, libelle}. Lève PeriodeErreur."""
    sequences = sequences_de_annee(annee.id)
    mode = mode_de_annee(annee)
    if periode == 'annuel':
        if not sequences:
            raise PeriodeErreur("Aucune séquence définie pour cette année scolaire")
        return {"type": "annuel", "sequences": sequences, "composante": None,
                "titre": "BILAN ANNUEL", "libelle": "Année"}
    trouve = re.fullmatch(r'(seq|tri):(\d+)(?::(\w+))?', periode or '')
    if not trouve:
        raise PeriodeErreur("Période invalide (attendu : seq:<id>, seq:<id>:<évaluation>, tri:<id> ou annuel)")
    genre, ident, code = trouve.group(1), int(trouve.group(2)), trouve.group(3)
    if genre == 'tri':
        membres = [s for s in sequences if s.trimestre_id == ident]
        if not membres or code:
            raise PeriodeErreur("Trimestre introuvable ou sans séquence pour cette année scolaire", 404)
        libelle = membres[0].trimestre.libelle
        return {"type": "trimestre", "sequences": membres, "composante": None,
                "titre": (libelle or 'TRIMESTRE').upper(), "libelle": libelle}
    sequence = next((s for s in sequences if s.id == ident), None)
    if sequence is None:
        raise PeriodeErreur("Séquence introuvable pour cette année scolaire", 404)
    numero = _numero(sequence)
    titre = f"CONTRÔLE CONTINU N°{numero}" if numero else (sequence.libelle or '').upper()
    if code is None:
        return {"type": "sequence", "sequences": [sequence], "composante": None, "titre": titre,
                "libelle": sequence.libelle}
    if code not in codes_composantes(mode) or len(codes_composantes(mode)) == 1:
        raise PeriodeErreur("Évaluation invalide pour le mode d'évaluation de cette année")
    nom = next(l for c, l, _p in composantes(mode) if c == code)
    return {"type": "evaluation", "sequences": [sequence], "composante": code,
            "titre": f"{titre} — {nom.upper()}", "libelle": f"{sequence.libelle} — {nom}"}


def periodes_pv(annee):
    """Périodes proposées pour le procès-verbal d'une année : chaque
    séquence (et, en Collège/Institut, chacune de ses évaluations), chaque
    trimestre."""
    mode = mode_de_annee(annee)
    evaluations = composantes(mode) if len(composantes(mode)) > 1 else []
    resultat = []
    vus = set()
    sequences = sequences_de_annee(annee.id)
    for s in sequences:
        if s.trimestre_id not in vus:
            vus.add(s.trimestre_id)
            membres = [x for x in sequences if x.trimestre_id == s.trimestre_id]
            resultat.append({"value": f"tri:{s.trimestre_id}", "type": "trimestre", "trimestre_id": s.trimestre_id,
                             "libelle": f"{s.trimestre.libelle} ({' + '.join(x.libelle for x in membres)})"})
        resultat.append({"value": f"seq:{s.id}", "type": "sequence", "sequence_id": s.id, "trimestre_id": s.trimestre_id,
                         "libelle": f"{s.libelle}{' — toutes les évaluations' if evaluations else ''}"})
        for code, libelle, _p in evaluations:
            resultat.append({"value": f"seq:{s.id}:{code}", "type": "evaluation", "sequence_id": s.id,
                             "trimestre_id": s.trimestre_id, "libelle": f"{s.libelle} — {libelle}"})
    return resultat


def dispenses_de(insc_ids, mc_ids, seq_ids):
    """set((inscription_id, matiere_classe_id, sequence_id)) des dispenses."""
    if not insc_ids or not mc_ids or not seq_ids:
        return set()
    return {(d.inscription_id, d.matiere_classe_id, d.sequence_id) for d in Dispense.query.filter(
        Dispense.inscription_id.in_(list(insc_ids)), Dispense.matiere_classe_id.in_(list(mc_ids)),
        Dispense.sequence_id.in_(list(seq_ids))).all()}


def _contexte(etablissement_id, classe_id, annee_id, classe_ids_restriction):
    classe = db.session.get(Classe, classe_id) if classe_id else None
    if not classe or classe.etablissement_id != etablissement_id:
        raise PeriodeErreur("Classe introuvable", 404)
    if classe_ids_restriction is not None and classe.id not in classe_ids_restriction:
        raise PeriodeErreur("Cette classe ne vous est pas assignée", 403)
    annee = AnneeScolaire.query.filter_by(id=annee_id, etablissement_id=etablissement_id).first() if annee_id else None
    if not annee:
        raise PeriodeErreur("Année scolaire introuvable", 404)
    return classe, annee


def lister_trous(etablissement_id, classe_id, annee_id, periode, classe_ids_restriction=None):
    """Élèves (en cours) ayant au moins une note manquante sur la période,
    avec le détail des trous ; trous dispensés exclus."""
    classe, annee = _contexte(etablissement_id, classe_id, annee_id, classe_ids_restriction)
    p = resoudre_periode(periode, annee)
    mode = mode_de_annee(annee)
    codes = [p["composante"]] if p["composante"] else codes_composantes(mode)
    libelles = {c: l for c, l, _p in composantes(mode)}
    inscriptions = sorted(
        Inscription.query.filter(Inscription.classe_id == classe.id, Inscription.annee_scolaire_id == annee.id,
                                 Inscription.statut.in_(STATUTS_INSCRIPTION_EN_COURS)).all(),
        key=lambda i: ((i.eleve.nom or '').lower(), (i.eleve.prenom or '').lower()))
    mcs = sorted(MatiereClasse.query.filter_by(classe_id=classe.id).all(),
                 key=lambda mc: (mc.matiere.libelle if mc.matiere else '').lower())
    insc_ids, mc_ids, seq_ids = [i.id for i in inscriptions], [mc.id for mc in mcs], [s.id for s in p["sequences"]]
    saisies = set()
    if insc_ids and mc_ids:
        for n in Note.query.filter(Note.inscription_id.in_(insc_ids), Note.matiere_classe_id.in_(mc_ids),
                                   Note.sequence_id.in_(seq_ids)).all():
            if n.valeur is not None or n.absent:
                saisies.add((n.inscription_id, n.matiere_classe_id, n.sequence_id, n.composante or 'note'))
    dispenses = dispenses_de(insc_ids, mc_ids, seq_ids)

    eleves, total = [], 0
    for insc in inscriptions:
        trous = []
        for mc in mcs:
            for s in p["sequences"]:
                if (insc.id, mc.id, s.id) in dispenses:
                    continue
                manquantes = [c for c in codes if (insc.id, mc.id, s.id, c) not in saisies]
                for c in manquantes:
                    trous.append({
                        "matiere_classe_id": mc.id,
                        "matiere": mc.matiere.libelle if mc.matiere else f"Matière #{mc.matiere_id}",
                        "coefficient": mc.coefficient,
                        "enseignant": (f"{mc.enseignant.nom} {mc.enseignant.prenom or ''}".strip()
                                       if mc.enseignant else None),
                        "sequence_id": s.id, "sequence": s.libelle,
                        "composante": c if len(codes_composantes(mode)) > 1 else None,
                        "evaluation": libelles.get(c) if len(codes_composantes(mode)) > 1 else None,
                    })
        if trous:
            total += len(trous)
            eleves.append({"inscription_id": insc.id, "nom": insc.eleve.nom, "prenom": insc.eleve.prenom,
                           "matricule": insc.eleve.matricule, "trous": trous})
    return {"classe_id": classe.id, "periode": periode, "titre": p["titre"], "nb_trous": total,
            "eleves": eleves, "effectif": len(inscriptions)}


def _verifier_cible(etablissement_id, data, classe_ids_restriction):
    """(inscription, matiere_classe, sequence) d'un trou, après contrôle du
    périmètre ; lève PeriodeErreur."""
    try:
        insc = db.session.get(Inscription, int(data.get('inscription_id')))
        mc = db.session.get(MatiereClasse, int(data.get('matiere_classe_id')))
        sequence = db.session.get(Sequence, int(data.get('sequence_id')))
    except (TypeError, ValueError):
        raise PeriodeErreur("inscription_id, matiere_classe_id et sequence_id requis")
    if not insc or not mc or not sequence or mc.classe.etablissement_id != etablissement_id \
            or insc.classe_id != mc.classe_id \
            or sequence.trimestre.annee_scolaire_id != insc.annee_scolaire_id:
        raise PeriodeErreur("Élève, matière ou séquence invalide", 404)
    if classe_ids_restriction is not None and mc.classe_id not in classe_ids_restriction:
        raise PeriodeErreur("Cette classe ne vous est pas assignée", 403)
    return insc, mc, sequence


def poser_dispense(etablissement_id, data, classe_ids_restriction=None):
    insc, mc, sequence = _verifier_cible(etablissement_id, data, classe_ids_restriction)
    existante = Dispense.query.filter_by(inscription_id=insc.id, matiere_classe_id=mc.id,
                                         sequence_id=sequence.id).first()
    if existante:
        return existante.to_dict(), 200
    dispense = Dispense(inscription_id=insc.id, matiere_classe_id=mc.id, sequence_id=sequence.id,
                        motif=(data.get('motif') or '').strip()[:255] or None, cree_le=datetime.utcnow())
    db.session.add(dispense)
    db.session.commit()
    return dispense.to_dict(), 201


def retirer_dispense(etablissement_id, data, classe_ids_restriction=None):
    insc, mc, sequence = _verifier_cible(etablissement_id, data, classe_ids_restriction)
    existante = Dispense.query.filter_by(inscription_id=insc.id, matiere_classe_id=mc.id,
                                         sequence_id=sequence.id).first()
    if existante:
        db.session.delete(existante)
        db.session.commit()
    return {"message": "Dispense retirée"}, 200


def combler_trou(etablissement_id, data, classe_ids_restriction=None):
    """Saisit une note MANQUANTE depuis la fenêtre des trous (titulaire,
    censeur, Admin, SuperAdmin) : refusé si une note existe déjà (une
    correction passe par la saisie normale). Le verrou de séquence ne
    s'applique pas : c'est le circuit prévu pour compléter avant le conseil."""
    from services.evaluation_services import create_note_scoped
    insc, mc, sequence = _verifier_cible(etablissement_id, data, classe_ids_restriction)
    composante = data.get('composante') or None
    deja = Note.query.filter_by(inscription_id=insc.id, matiere_classe_id=mc.id, sequence_id=sequence.id,
                                composante=composante or 'note').first()
    if composante is None and len(codes_composantes(mode_de_annee(insc.annee_scolaire))) > 1:
        raise PeriodeErreur("Précisez l'évaluation (CC, DS…) de la note")
    if deja is not None and (deja.valeur is not None or deja.absent):
        raise PeriodeErreur("Une note est déjà saisie : modifiez-la depuis la saisie des notes", 409)
    corps = {'inscription_id': insc.id, 'matiere_classe_id': mc.id, 'sequence_id': sequence.id,
             'valeur': data.get('valeur'), 'absent': bool(data.get('absent'))}
    if composante:
        corps['composante'] = composante
    if deja is not None:
        corps['version_base'] = deja.version
    return create_note_scoped(corps, etablissement_id, None)
