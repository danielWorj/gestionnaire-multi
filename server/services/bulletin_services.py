import re

from models.evaluation_models import Note, Discipline
from models.pedagogie_models import MatiereClasse, TitulaireClasse
from models.inscription_models import Inscription, STATUTS_INSCRIPTION_EN_COURS
from models.structure_models import Classe, AnneeScolaire, Trimestre, Sequence
from services.import_commun import jetons_classe


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


def classe_label(classe):
    cycle = classe.cycle.libelle if classe.cycle else None
    if cycle and classe.option:
        return f"{cycle} {classe.option}"
    return cycle or classe.option or f"Classe #{classe.id}"


def sequences_annee(annee_id):
    return (
        Sequence.query
        .join(Trimestre, Trimestre.id == Sequence.trimestre_id)
        .filter(Trimestre.annee_scolaire_id == annee_id)
        .order_by(Trimestre.id, Sequence.id)
        .all()
    )


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
    notes = {}
    if insc_ids and mc_ids:
        for n in Note.query.filter(Note.inscription_id.in_(insc_ids), Note.matiere_classe_id.in_(mc_ids),
                                   Note.sequence_id.in_(seq_ids)).all():
            if n.valeur is not None:
                notes[(n.inscription_id, n.matiere_classe_id, n.sequence_id)] = float(n.valeur)
            elif n.absent:
                notes[(n.inscription_id, n.matiere_classe_id, n.sequence_id)] = 'ABS'

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
        niveau = niveau_classe(classe)
        anterieures = (
            Inscription.query
            .join(Classe, Classe.id == Inscription.classe_id)
            .join(AnneeScolaire, AnneeScolaire.id == Inscription.annee_scolaire_id)
            .filter(Inscription.eleve_id.in_([i.eleve_id for i in inscriptions]),
                    AnneeScolaire.libelle < annee.libelle,
                    Classe.etablissement_id == etablissement.id)
            .all()
        )
        redoublants = {i.eleve_id for i in anterieures if niveau_classe(i.classe) == niveau}

    titulaire = TitulaireClasse.query.filter_by(classe_id=classe.id, annee_scolaire_id=annee.id).first()

    # --- Moyennes par matière et par séquence ------------------------------
    def _valeur(insc_id, mc_id, seq_id):
        v = notes.get((insc_id, mc_id, seq_id))
        return v if isinstance(v, float) else None

    moy_matiere = {(i, mc.id): _moyenne([_valeur(i, mc.id, s) for s in seq_ids])
                   for i in insc_ids for mc in matieres_classe}

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

    def _moyenne_ponderee(i):
        points = coefs = 0
        for mc in matieres_classe:
            moy = moy_matiere[(i, mc.id)]
            if moy is not None:
                points += moy * mc.coefficient
                coefs += mc.coefficient
        return points / coefs if coefs else None

    moy_periode = {i: _moyenne_ponderee(i) for i in insc_ids}

    rang_periode = _rangs(moy_periode)
    rang_sequence = {s: _rangs({i: moy_sequence[(i, s)] for i in insc_ids}) for s in seq_ids}
    rang_matiere = {mc.id: _rangs({i: moy_matiere[(i, mc.id)] for i in insc_ids}) for mc in matieres_classe}

    classees = [m for m in moy_periode.values() if m is not None]
    statistiques = {
        "moyenne_classe": _moyenne(classees),
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
        for g in groupes_ordonnes:
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
                    "moyenne": moy,
                    "coefficient": mc.coefficient,
                    "points": moy * mc.coefficient if moy is not None else None,
                    "rang": rang_matiere[mc.id][insc.id],
                    "appreciation": _seuil(moy, BAREME_APPRECIATION),
                    "classe": moy is not None,
                })
            total_coef += g_coef
            total_points += g_points
            blocs.append({"libelle": g["libelle"], "lignes": lignes, "total_coef": g_coef,
                          "total_points": g_points, "moyenne": g_points / g_coef if g_coef else None})

        fiches = [disciplines.get((insc.id, s)) for s in seq_ids]
        discipline = [
            {"libelle": libelle,
             "valeurs": [getattr(f, champ) if f else None for f in fiches],
             "total": sum(getattr(f, champ) or 0 for f in fiches if f)}
            for champ, libelle in LIGNES_DISCIPLINE
        ]

        moyenne = moy_periode[insc.id]
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
            },
            "groupes": blocs,
            "total_coef": total_coef,
            "total_points": total_points,
            "sequences": [{"moyenne": moy_sequence[(insc.id, s)], "rang": rang_sequence[s][insc.id]}
                          for s in seq_ids],
            "moyenne": moyenne,
            "rang": rang_periode[insc.id],
            "mention": _seuil(moyenne, MENTIONS),
            "sanction": _seuil(moyenne, SANCTIONS_TRAVAIL),
            "discipline": discipline,
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
        "statistiques": statistiques,
        "legende": LEGENDE_APPRECIATION,
        "bulletins": bulletins,
    }
