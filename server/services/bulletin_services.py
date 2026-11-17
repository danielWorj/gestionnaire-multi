import re
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP

from models.evaluation_models import Note, Discipline
from models.pedagogie_models import MatiereClasse, TitulaireClasse
from models.inscription_models import Inscription, STATUTS_INSCRIPTION_EN_COURS
from models.structure_models import Classe, AnneeScolaire, Trimestre, Sequence, sequences_de_annee
from services.import_commun import jetons_classe
from services.trous_services import dispenses_de
from services.mode_evaluation_services import (
    composantes, est_compose, mode_de_annee, modele_bulletin_effectif, notes_par_sequence,
)


# ---------------------------------------------------------------------------
# Bulletins de notes (séquentiel, trimestriel, annuel)
#
# Calcul centralisé côté serveur : la même structure alimente l'aperçu HTML
# de la page Bulletins et le PDF (WeasyPrint), cf. api/bulletin_api.py et
# static/templates/bulletins/bulletin.html.
#
# Règles (modèle du bulletin annuel papier) :
#   - colonnes de notes : la séquence seule (séquentiel), les séquences du
#     trimestre (trimestriel) ou toutes les séquences de l'année (annuel) ;
#   - note d'une séquence : selon le mode d'évaluation de l'année (Lycée :
#     la note saisie ; Collège/Institut : CC, DS(, Ev. Tr.) pondérés, cf.
#     mode_evaluation_services) ; en Collège/Institut, les colonnes du
#     bulletin séquentiel/trimestriel détaillent ces évaluations ;
#   - moyenne d'une matière = moyenne des notes disponibles sur la période
#     (séquences sans note ou élève absent ignorées) ;
#   - matière sans aucune note -> « Non classé(e) », exclue des totaux ;
#   - matières regroupées par GroupeMatiere (tri par ordre puis libellé),
#     chaque groupe ayant son sous-total (coef, points, moyenne/20) ;
#   - moyenne générale d'une séquence = Σ(note × coef) / Σ coef ;
#   - moyenne générale de la période = Σ(moy matière × coef) / Σ coef des
#     matières classées, soit exactement « total points / total coef »
#     imprimé sur le bulletin (l'ancienne moyenne des moyennes de séquences
#     différait de ce total dès qu'une note manquait) ;
#   - seuls les élèves en cours (STATUTS_INSCRIPTION_EN_COURS) sont
#     classés : un élève radié ou transféré ne compte ni dans l'effectif ni
#     dans les rangs.
# ---------------------------------------------------------------------------

# Appréciation par matière (légende du bulletin).
BAREME_APPRECIATION = [(16, 'A+'), (12, 'A'), (10, 'ECA'), (0, 'NA')]
LEGENDE_APPRECIATION = "NA (Non Acquis) ; ECA (En Cours d'Acquisition) ; A (Acquis) ; A+ (Expert)"
# Libellés en toutes lettres (modèles de bulletin qui n'impriment pas la légende).
APPRECIATIONS_LONGUES = {'A+': 'Expert', 'A': 'Acquis', 'ECA': "En cours d'acquisition", 'NA': 'Non acquis'}

MENTIONS = [(18, 'Excellent'), (16, 'Très bien'), (14, 'Bien'), (12, 'Assez bien'),
            (10, 'Passable'), (7, 'Médiocre'), (5, 'Faible'), (0, 'Très faible')]

SANCTIONS_TRAVAIL = [(16, "Tableau d'honneur + Félicitations"), (14, "Tableau d'honneur + Encouragements"),
                     (12, "Tableau d'honneur"), (10, 'Travail acceptable'), (8, 'Travail peu acceptable'),
                     (6, 'Avertissement travail'), (0, 'Blâme travail')]

LIGNES_DISCIPLINE = [
    ('absences_non_justifiees', 'Absences non justifiées'),
    ('absences_justifiees', 'Absences justifiées'),
    ('retards', 'Retards'),
    ('exclusions', 'Exclusions'),
]


class BulletinErreur(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def _t2(valeur):
    """Troncature à 2 décimales (jamais d'arrondi : 9,996 -> 9,99), comme
    le procès-verbal. Le bruit des flottants est d'abord absorbé (12,999999…
    issu d'une division exacte reste 13,00)."""
    if valeur is None or isinstance(valeur, str):
        return valeur
    propre = Decimal(repr(float(valeur))).quantize(Decimal('1e-9'), rounding=ROUND_HALF_UP)
    return float(propre.quantize(Decimal('0.01'), rounding=ROUND_DOWN))


def _seuil(valeur, bareme):
    if valeur is None:
        return None
    return next(libelle for minimum, libelle in bareme if valeur >= minimum)


def _moyenne(valeurs):
    valeurs = [v for v in valeurs if v is not None]
    return sum(valeurs) / len(valeurs) if valeurs else None


def _rangs(valeurs_par_id):
    """{id: valeur|None} -> {id: rang|None}, rang = 1 + nombre de valeurs
    strictement supérieures (ex æquo au même rang)."""
    classees = [v for v in valeurs_par_id.values() if v is not None]
    return {cle: (None if v is None else 1 + sum(1 for autre in classees if autre > v))
            for cle, v in valeurs_par_id.items()}


def _libelle_court_sequence(sequence):
    """'Sequence 3' / 'Séquence 3' -> 'SEQ3' (en-tête de colonne)."""
    trouve = re.search(r'(\d+)\s*$', sequence.libelle or '')
    return f"SEQ{trouve.group(1)}" if trouve else sequence.libelle


def niveau_classe(classe):
    """Clé de NIVEAU d'une classe, indépendante de sa section : « 6 eme A »
    et « 6e B » -> ('6',), « Tle C » -> ('tle',), « MACO 2 » -> ('maco', '2').
    Le niveau est lu dans l'option (« Premier Cycle » + « 6 eme A »), à
    défaut dans le libellé du cycle quand c'est lui qui porte le niveau
    (« 6ème » + « A ») ; jetons jusqu'au premier chiffre ou « tle » inclus."""
    for source in (classe.option, classe.cycle.libelle if classe.cycle else None):
        jetons = jetons_classe(source or '')
        for i, jeton in enumerate(jetons):
            if jeton.isdigit() or jeton == 'tle':
                return (classe.cycle_id,) + tuple(jetons[:i + 1])
    return (classe.cycle_id, (classe.option or '').strip().lower())


def cle_niveau(classe):
    """Niveau EFFECTIF d'une classe : son Niveau s'il est renseigné, sinon
    celui déduit de son nom (niveau_classe). Deux classes du même niveau
    sont parallèles (changement de classe sans perte des notes)."""
    if classe.niveau_id:
        return ('niveau', classe.niveau_id)
    return ('auto',) + niveau_classe(classe)


def libelle_niveau_deduit(classe):
    """Libellé proposé pour le niveau d'une classe : « 6 eme A » -> « 6E »,
    « MACO 2 » -> « MACO 2 », « Tle C » -> « TLE » ; préfixé du cycle quand
    le niveau est lu dans l'option."""
    cle = niveau_classe(classe)[1:]
    jetons = [f"{j}e" if j.isdigit() and len(cle) == 1 else j for j in cle]
    texte = ' '.join(jetons).upper().strip()
    cycle = classe.cycle.libelle if classe.cycle else ''
    if not texte:
        return cycle or f"Classe #{classe.id}"
    return texte[:50]


def classe_label(classe):
    cycle = classe.cycle.libelle if classe.cycle else None
    if cycle and classe.option:
        return f"{cycle} {classe.option}"
    return cycle or classe.option or f"Classe #{classe.id}"


def sequences_annee(annee_id):
    return sequences_de_annee(annee_id)


def periodes_disponibles(annee_id):
    """Périodes proposées pour une année : chaque trimestre (avec ses
    séquences), chaque séquence et l'annuel."""
    sequences = sequences_annee(annee_id)
    periodes = []
    trimestres_vus = []
    for sequence in sequences:
        if sequence.trimestre_id not in trimestres_vus:
            trimestres_vus.append(sequence.trimestre_id)
            trimestre = sequence.trimestre
            membres = [s for s in sequences if s.trimestre_id == trimestre.id]
            periodes.append({"value": f"tri:{trimestre.id}", "type": "trimestre",
                             "libelle": f"{trimestre.libelle} ({' + '.join(s.libelle for s in membres)})"})
        periodes.append({"value": f"seq:{sequence.id}", "type": "sequence",
                         "libelle": f"{sequence.trimestre.libelle} — {sequence.libelle}"})
    if sequences:
        periodes.append({"value": "annuel", "type": "annuel", "libelle": "Bulletin annuel"})
    return periodes


def _resoudre_periode(periode, annee):
    """Retourne (type, sequences de la période, titre, libellé court)."""
    sequences = sequences_annee(annee.id)
    if periode == 'annuel':
        if not sequences:
            raise BulletinErreur("Aucune séquence définie pour cette année scolaire")
        return 'annuel', sequences, 'BULLETIN DE NOTES ANNUEL', 'ANNUEL'

    trouve = re.fullmatch(r'(seq|tri):(\d+)', periode or '')
    if not trouve:
        raise BulletinErreur("Période invalide (attendu : seq:<id>, tri:<id> ou annuel)")
    genre, ident = trouve.group(1), int(trouve.group(2))

    if genre == 'seq':
        sequence = next((s for s in sequences if s.id == ident), None)
        if sequence is None:
            raise BulletinErreur("Séquence introuvable pour cette année scolaire", 404)
        return ('sequence', [sequence], f"BULLETIN DE NOTES — {sequence.libelle.upper()}",
                _libelle_court_sequence(sequence))

    membres = [s for s in sequences if s.trimestre_id == ident]
    if not membres:
        raise BulletinErreur("Trimestre introuvable ou sans séquence pour cette année scolaire", 404)
    libelle = membres[0].trimestre.libelle
    return 'trimestre', membres, f"BULLETIN DE NOTES — {libelle.upper()}", libelle.upper()


def construire_bulletins(etablissement, classe_id, annee_id, periode, classe_ids_restriction=None,
                         inscription_ids=None):
    """Calcule les bulletins de toute une classe pour une période (le rang
    exige de calculer la classe entière), puis ne renvoie que ceux de
    inscription_ids si fourni. Lève BulletinErreur en cas de paramètre
    invalide ou hors périmètre."""
    classe = Classe.query.get(classe_id) if classe_id else None
    if not classe or classe.etablissement_id != etablissement.id:
        raise BulletinErreur("Classe introuvable", 404)
    if classe_ids_restriction is not None and classe.id not in classe_ids_restriction:
        raise BulletinErreur("Cette classe ne vous est pas assignée", 403)

    annee = AnneeScolaire.query.filter_by(id=annee_id, etablissement_id=etablissement.id).first()
    if not annee:
        raise BulletinErreur("Année scolaire introuvable", 404)

    type_periode, sequences, titre, libelle_periode = _resoudre_periode(periode, annee)
    seq_ids = [s.id for s in sequences]

    inscriptions = Inscription.query.filter(
        Inscription.classe_id == classe.id, Inscription.annee_scolaire_id == annee.id,
        Inscription.statut.in_(STATUTS_INSCRIPTION_EN_COURS),
    ).all()
    insc_ids = [i.id for i in inscriptions]
    effectif = len(inscriptions)

    matieres_classe = MatiereClasse.query.filter_by(classe_id=classe.id).all()
    mc_ids = [mc.id for mc in matieres_classe]

    # notes[(inscription_id, matiere_classe_id, sequence_id)] = float | 'ABS'
    # (note de la séquence, cf. mode_evaluation_services) ; detail[...] =
    # {composante: float | 'ABS' | None} en mode Collège/Institut.
    mode = mode_de_annee(annee)
    notes, detail = {}, {}
    if insc_ids and mc_ids:
        lignes_notes = Note.query.filter(Note.inscription_id.in_(insc_ids), Note.matiere_classe_id.in_(mc_ids),
                                         Note.sequence_id.in_(seq_ids)).all()
        for cle, ns in notes_par_sequence(lignes_notes, mode).items():
            if ns.valeur is not None:
                notes[cle] = _t2(ns.valeur)
            elif ns.absent:
                notes[cle] = 'ABS'
            detail[cle] = {c: (_t2(v) if v not in (None, 'ABS') else v) for c, v in ns.composantes.items()}

    # Dispenses (fenêtre des notes manquantes) : la matière ne compte pas
    # pour l'élève sur cette séquence — ni points, ni coefficient.
    dispenses = dispenses_de(insc_ids, mc_ids, seq_ids)
    for (i_id, mc_id, s_id) in dispenses:
        notes[(i_id, mc_id, s_id)] = 'DISP'
        detail[(i_id, mc_id, s_id)] = {code: 'DISP' for code, _l, _p in composantes(mode)}

    # Colonnes de notes du tableau : une par séquence, ou, en mode
    # Collège/Institut hors bulletin annuel, une par évaluation de chaque
    # séquence (« CC 1 », « DS 1 »…), comme sur le bulletin papier.
    # Le modèle « Original » du Collège ajoute après CC et DS la colonne
    # « Note » de la séquence (30 % CC + 70 % DS).
    modele = modele_bulletin_effectif(etablissement.modele_bulletin, mode)
    detailler = est_compose(mode) and type_periode != 'annuel'
    colonnes = []
    for s in sequences:
        if detailler:
            numero = _libelle_court_sequence(s).replace('SEQ', '')
            colonnes += [{"libelle": f"{libelle} N°{numero}", "sequence_id": s.id, "composante": code}
                         for code, libelle, _poids in composantes(mode)]
            if modele['colonne_note']:
                colonnes.append({"libelle": f"Note N°{numero}", "sequence_id": s.id, "composante": None})
        else:
            colonnes.append({"libelle": _libelle_court_sequence(s), "sequence_id": s.id, "composante": None})

    def _cellule(insc_id, mc_id, colonne):
        cle = (insc_id, mc_id, colonne["sequence_id"])
        if colonne["composante"] is None:
            return notes.get(cle)
        return detail.get(cle, {}).get(colonne["composante"])

    disciplines = {}
    if insc_ids:
        for d in Discipline.query.filter(Discipline.inscription_id.in_(insc_ids),
                                         Discipline.sequence_id.in_(seq_ids)).all():
            disciplines[(d.inscription_id, d.sequence_id)] = d

    # Statut N (nouveau) / R (redoublant) : déjà inscrit une année
    # ANTÉRIEURE dans une classe du même NIVEAU (cf. niveau_classe). Comparer
    # le seul cycle_id marquait redoublant tout élève passé de 6e en 5e
    # quand le cycle est « Premier Cycle ».
    redoublants = set()
    if inscriptions:
        niveau = cle_niveau(classe)
        anterieures = (
            Inscription.query
            .join(Classe, Classe.id == Inscription.classe_id)
            .join(AnneeScolaire, AnneeScolaire.id == Inscription.annee_scolaire_id)
            .filter(Inscription.eleve_id.in_([i.eleve_id for i in inscriptions]),
                    AnneeScolaire.libelle < annee.libelle,
                    Classe.etablissement_id == etablissement.id)
            .all()
        )
        redoublants = {i.eleve_id for i in anterieures if cle_niveau(i.classe) == niveau}

    titulaire = TitulaireClasse.query.filter_by(classe_id=classe.id, annee_scolaire_id=annee.id).first()

    # --- Moyennes par matière et par séquence ------------------------------
    def _valeur(insc_id, mc_id, seq_id):
        v = notes.get((insc_id, mc_id, seq_id))
        return v if isinstance(v, float) else None

    # Moyennes tronquées à 2 décimales (valeurs imprimées) ; les rangs sont
    # calculés sur les valeurs exactes, comme au procès-verbal.
    moy_matiere_exacte = {(i, mc.id): _moyenne([_valeur(i, mc.id, s) for s in seq_ids])
                          for i in insc_ids for mc in matieres_classe}
    moy_matiere = {cle: _t2(v) for cle, v in moy_matiere_exacte.items()}

    moy_sequence = {}
    for i in insc_ids:
        for s in seq_ids:
            points = coefs = 0
            for mc in matieres_classe:
                v = _valeur(i, mc.id, s)
                if v is not None:
                    points += v * mc.coefficient
                    coefs += mc.coefficient
            moy_sequence[(i, s)] = points / coefs if coefs else None
    rang_sequence = {s: _rangs({i: moy_sequence[(i, s)] for i in insc_ids}) for s in seq_ids}
    moy_sequence = {cle: _t2(v) for cle, v in moy_sequence.items()}

    # --- Évolution chronologique (graphe « rappel des moyennes ») -----------
    # Moyenne générale de chaque séquence de l'année, de la première jusqu'à
    # la dernière séquence de la période, et moyenne de la classe à chacune.
    sequences_an = sequences_annee(annee.id)
    fin = max((n for n, s in enumerate(sequences_an) if s.id in seq_ids), default=-1)
    sequences_evolution = sequences_an[:fin + 1] or sequences
    moy_evolution = dict(moy_sequence)
    anterieures = [s.id for s in sequences_evolution if s.id not in seq_ids]
    if anterieures and insc_ids and mc_ids:
        notes_ant = {}
        for cle, ns in notes_par_sequence(
                Note.query.filter(Note.inscription_id.in_(insc_ids), Note.matiere_classe_id.in_(mc_ids),
                                  Note.sequence_id.in_(anterieures)).all(), mode).items():
            if ns.valeur is not None:
                notes_ant[cle] = _t2(ns.valeur)
        for cle in dispenses_de(insc_ids, mc_ids, anterieures):
            notes_ant.pop(cle, None)
        for i in insc_ids:
            for s in anterieures:
                points = coefs = 0
                for mc in matieres_classe:
                    v = notes_ant.get((i, mc.id, s))
                    if v is not None:
                        points += v * mc.coefficient
                        coefs += mc.coefficient
                moy_evolution[(i, s)] = _t2(points / coefs) if coefs else None
    moy_classe_evolution = {}
    for s in sequences_evolution:
        valeurs = [moy_evolution.get((i, s.id)) for i in insc_ids]
        moy_classe_evolution[s.id] = _t2(_moyenne(valeurs))

    def _moyenne_ponderee(i):
        points = coefs = 0
        for mc in matieres_classe:
            moy = moy_matiere[(i, mc.id)]
            if moy is not None:
                points += moy * mc.coefficient
                coefs += mc.coefficient
        return points / coefs if coefs else None

    moy_periode_exacte = {i: _moyenne_ponderee(i) for i in insc_ids}
    moy_periode = {i: _t2(v) for i, v in moy_periode_exacte.items()}

    rang_periode = _rangs(moy_periode_exacte)
    rang_matiere = {mc.id: _rangs({i: moy_matiere_exacte[(i, mc.id)] for i in insc_ids}) for mc in matieres_classe}

    # Moyenne de la classe et extrêmes (note min / max) par matière, sur les
    # élèves classés dans la matière.
    stats_matiere = {}
    for mc in matieres_classe:
        valeurs = [moy_matiere[(i, mc.id)] for i in insc_ids if moy_matiere[(i, mc.id)] is not None]
        stats_matiere[mc.id] = {"moyenne_classe": _t2(_moyenne(valeurs)),
                                "note_min": min(valeurs) if valeurs else None,
                                "note_max": max(valeurs) if valeurs else None}

    classees = [m for m in moy_periode.values() if m is not None]
    statistiques = {
        "moyenne_classe": _t2(_moyenne(classees)),
        "moyenne_min": min(classees) if classees else None,
        "moyenne_max": max(classees) if classees else None,
        "nb_classes": len(classees),
        "nb_sup_10": sum(1 for m in classees if m >= 10),
        "nb_sup_12": sum(1 for m in classees if m >= 12),
        "nb_inf_10": sum(1 for m in classees if m < 10),
    }
    statistiques["taux_reussite"] = (100 * statistiques["nb_sup_10"] / len(classees)) if classees else None

    # --- Groupes de matières -----------------------------------------------
    groupes = {}
    for mc in matieres_classe:
        groupe = mc.matiere.groupe if mc.matiere else None
        cle = (groupe.ordre, groupe.libelle.lower(), groupe.id) if groupe else (10**9, '', 0)
        groupes.setdefault(cle, {"libelle": groupe.libelle if groupe else 'Autres enseignements',
                                 "matieres": []})["matieres"].append(mc)
    groupes_ordonnes = [groupes[cle] for cle in sorted(groupes)]
    for g in groupes_ordonnes:
        g["matieres"].sort(key=lambda mc: (mc.matiere.libelle if mc.matiere else '').lower())

    # Moyenne de chaque élève par groupe de matières, et son rang dans le groupe.
    def _moyenne_groupe(i, mcs):
        points = coefs = 0
        for mc in mcs:
            moy = moy_matiere[(i, mc.id)]
            if moy is not None:
                points += moy * mc.coefficient
                coefs += mc.coefficient
        return points / coefs if coefs else None

    rang_groupe = [_rangs({i: _moyenne_groupe(i, g["matieres"]) for i in insc_ids}) for g in groupes_ordonnes]

    # Numéro d'ordre de l'élève dans la liste alphabétique de la classe.
    numeros = {insc.id: n for n, insc in enumerate(
        sorted(inscriptions, key=lambda x: ((x.eleve.nom or '').lower(), (x.eleve.prenom or '').lower())), 1)}

    def _moyennes_colonnes(insc_id, mcs):
        """Moyenne de l'élève dans chaque colonne de notes : Σ(note × coef) /
        Σ coef des matières notées dans cette colonne."""
        resultat = []
        for c in colonnes:
            points = coefs = 0
            for mc in mcs:
                v = _cellule(insc_id, mc.id, c)
                if isinstance(v, float):
                    points += v * mc.coefficient
                    coefs += mc.coefficient
            resultat.append(_t2(points / coefs) if coefs else None)
        return resultat

    def _enseignant_nom(mc):
        e = mc.enseignant
        return f"{e.nom} {e.prenom}".strip() if e else None

    # --- Bulletins -----------------------------------------------------------
    cibles = inscriptions
    if inscription_ids is not None:
        voulues = set(inscription_ids)
        cibles = [i for i in inscriptions if i.id in voulues]

    bulletins = []
    for insc in cibles:
        eleve = insc.eleve
        blocs = []
        total_coef = total_points = 0
        for g_index, g in enumerate(groupes_ordonnes):
            lignes = []
            g_coef = g_points = 0
            for mc in g["matieres"]:
                moy = moy_matiere[(insc.id, mc.id)]
                if moy is not None:
                    g_coef += mc.coefficient
                    g_points += moy * mc.coefficient
                lignes.append({
                    "matiere": mc.matiere.libelle if mc.matiere else f"Matière #{mc.matiere_id}",
                    "enseignant": _enseignant_nom(mc),
                    "notes": [notes.get((insc.id, mc.id, s)) for s in seq_ids],
                    "cellules": [_cellule(insc.id, mc.id, c) for c in colonnes],
                    "moyenne": moy,
                    "coefficient": mc.coefficient,
                    "points": _t2(moy * mc.coefficient) if moy is not None else None,
                    "rang": rang_matiere[mc.id][insc.id],
                    "appreciation": _seuil(moy, BAREME_APPRECIATION),
                    "appreciation_longue": APPRECIATIONS_LONGUES.get(_seuil(moy, BAREME_APPRECIATION)),
                    "classe": moy is not None,
                    # Dispensé sur toute la période : coefficient annulé.
                    "dispense": all((insc.id, mc.id, s) in dispenses for s in seq_ids),
                    **stats_matiere[mc.id],
                })
            total_coef += g_coef
            total_points += g_points
            g_moy = _t2(g_points / g_coef) if g_coef else None
            blocs.append({"libelle": g["libelle"], "lignes": lignes, "total_coef": g_coef,
                          "total_points": _t2(g_points), "moyenne": g_moy,
                          "moyennes_colonnes": _moyennes_colonnes(insc.id, g["matieres"]),
                          "rang": rang_groupe[g_index][insc.id],
                          "appreciation": _seuil(g_moy, BAREME_APPRECIATION),
                          "appreciation_longue": APPRECIATIONS_LONGUES.get(_seuil(g_moy, BAREME_APPRECIATION))})

        fiches = [disciplines.get((insc.id, s)) for s in seq_ids]
        discipline = [
            {"libelle": libelle,
             "valeurs": [getattr(f, champ) if f else None for f in fiches],
             "total": sum(getattr(f, champ) or 0 for f in fiches if f)}
            for champ, libelle in LIGNES_DISCIPLINE
        ]

        moyenne = moy_periode[insc.id]
        total_points = _t2(total_points)
        bulletins.append({
            "inscription_id": insc.id,
            "eleve": {
                "id": eleve.id,
                "nom": eleve.nom,
                "prenom": eleve.prenom,
                "matricule": eleve.matricule,
                "sexe": eleve.sexe,
                "date_naissance": eleve.date_naissance.strftime('%d/%m/%Y') if eleve.date_naissance else None,
                "lieu_naissance": eleve.lieu_naissance,
                "statut": 'R' if eleve.id in redoublants else 'N',
                "numero": numeros[insc.id],
            },
            "groupes": blocs,
            "total_coef": total_coef,
            "total_points": total_points,
            "moyennes_colonnes": _moyennes_colonnes(insc.id, matieres_classe),
            "sequences": [{"moyenne": moy_sequence[(insc.id, s)], "rang": rang_sequence[s][insc.id]}
                          for s in seq_ids],
            # Ordre chronologique, de la 1re séquence de l'année à la fin de la période.
            "evolution": [{"libelle": _libelle_court_sequence(s), "moyenne": moy_evolution.get((insc.id, s.id)),
                           "moyenne_classe": moy_classe_evolution[s.id]}
                          for s in sequences_evolution],
            "moyenne": moyenne,
            "rang": rang_periode[insc.id],
            "mention": _seuil(moyenne, MENTIONS),
            "sanction": _seuil(moyenne, SANCTIONS_TRAVAIL),
            "appreciation": _seuil(moyenne, BAREME_APPRECIATION),
            "appreciation_longue": APPRECIATIONS_LONGUES.get(_seuil(moyenne, BAREME_APPRECIATION)),
            # Cases « travail » des modèles de bulletin (mêmes seuils que SANCTIONS_TRAVAIL).
            "travail": {
                "tableau_honneur": moyenne is not None and moyenne >= 12,
                "encouragements": moyenne is not None and 14 <= moyenne < 16,
                "felicitations": moyenne is not None and moyenne >= 16,
                "avertissement": moyenne is not None and 6 <= moyenne < 8,
                "blame": moyenne is not None and moyenne < 6,
            },
            "discipline": discipline,
            "discipline_totaux": {champ: d["total"] for (champ, _l), d in zip(LIGNES_DISCIPLINE, discipline)},
            "observations": [f.observation for f in fiches if f and f.observation],
        })

    etab = etablissement.to_dict()
    # « BP 66 » / « B.P. 66 » -> « 66 » : le gabarit ajoute B.P. / P.O. Box.
    etab["bp_numero"] = re.sub(r'^\s*(B\.?\s*P\.?|P\.?\s*O\.?\s*Box)\s*', '', etab.get("bp") or '', flags=re.I)

    return {
        "etablissement": etab,
        "classe": {"id": classe.id, "label": classe_label(classe)},
        "annee": {"id": annee.id, "libelle": annee.libelle},
        "titulaire": (f"{titulaire.enseignant.nom} {titulaire.enseignant.prenom}".strip()
                      if titulaire and titulaire.enseignant else None),
        "effectif": effectif,
        "periode": {"value": periode, "type": type_periode, "titre": titre, "libelle": libelle_periode},
        "sequences": [{"id": s.id, "libelle": s.libelle, "court": _libelle_court_sequence(s)} for s in sequences],
        "mode_evaluation": mode,
        # Gabarit d'impression (cf. structure_models.MODELES_BULLETIN).
        "modele_bulletin": modele,
        "colonnes_notes": [{"libelle": c["libelle"], "composante": c["composante"]} for c in colonnes],
        # Colonne « moyenne » de la matière : dès que la période a plusieurs
        # séquences, ou que la séquence est détaillée en évaluations.
        "colonne_moyenne": len(sequences) > 1 or detailler,
        "statistiques": statistiques,
        "legende": LEGENDE_APPRECIATION,
        "bulletins": bulletins,
    }
