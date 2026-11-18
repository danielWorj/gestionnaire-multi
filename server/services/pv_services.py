import re
from decimal import Decimal, ROUND_DOWN

from models.evaluation_models import Note
from models.inscription_models import Inscription, STATUTS_INSCRIPTION_EN_COURS
from models.pedagogie_models import MatiereClasse, TitulaireClasse
from models.structure_models import Classe, AnneeScolaire, Trimestre, Sequence, sequences_de_annee
from services.mode_evaluation_services import mode_de_annee, notes_par_sequence
from services.trous_services import PeriodeErreur, dispenses_de, resoudre_periode


# ---------------------------------------------------------------------------
# Procès-verbal d'évaluation (« Contrôle continu N°x ») : le tableau de toute
# une classe pour UNE séquence, tel qu'il est tenu à la main (A4 paysage).
#
# Module INDÉPENDANT du bulletin (aucun import de bulletin_services) : le PV a
# ses propres règles, qui diffèrent de celles du bulletin individuel :
#
#   - cellule d'une matière = note /20 × coefficient (points pondérés) ;
#   - Totaux = somme des cellules ;
#   - moyenne = Totaux ÷ Σ coefficients de TOUTES les matières de la classe
#     (dénominateur fixe, le même pour tous les élèves) ;
#   - la moyenne est TRONQUÉE à 2 décimales, jamais arrondie (11,6985 -> 11,69) ;
#   - rang = 1 + nombre d'élèves classés strictement meilleurs, calculé sur la
#     valeur exacte (D2) ; ex æquo au même rang ;
#   - note de la séquence selon le mode d'évaluation de l'année (Lycée : la
#     note saisie ; Collège/Institut : CC, DS(, Ev. Tr.) pondérés, une
#     évaluation manquante comptant 0, cf. mode_evaluation_services) ;
#   - note « absent » = 0 (D3) : l'élève reste classé ;
#   - note non saisie (aucune ligne Note, ou ligne sans valeur et sans
#     absence) = élève NON CLASSÉ (N.C.) : total partiel affiché, ni moyenne
#     ni rang (D4) ;
#   - rouge pour toute note < 10 (D5), moyenne comprise ;
#   - seuls les élèves en cours (Actif, Suspendu) figurent au PV (D7).
#
# Tous les calculs se font en Decimal ; les chaînes *_fmt sont produites ici :
# le gabarit et le front n'ont aucun calcul à faire.
# ---------------------------------------------------------------------------

CENT = Decimal('0.01')
SEUIL_ROUGE = Decimal('10')


class PvErreur(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


# --- Utilitaires de calcul et de formatage ---------------------------------

def tronquer_2(valeur):
    """Troncature (et non arrondi) à 2 décimales : 13.45588 -> 13.45."""
    return Decimal(valeur).quantize(CENT, rounding=ROUND_DOWN)


def fmt_points(valeur):
    """Virgule décimale, 2 décimales au plus, sans zéros inutiles :
    42.50 -> « 42,5 », 26.00 -> « 26 », 27.75 -> « 27,75 »."""
    if valeur is None:
        return ''
    texte = format(Decimal(valeur).quantize(CENT, rounding=ROUND_DOWN), 'f')
    if '.' in texte:
        texte = texte.rstrip('0').rstrip('.')
    return texte.replace('.', ',')


def fmt_moyenne(valeur):
    """Moyenne sur 2 chiffres entiers et 2 décimales : 8.88 -> « 08,88 »."""
    if valeur is None:
        return ''
    return format(Decimal(valeur), '05.2f').replace('.', ',')


def fmt_rang(rang, sexe=None):
    """1 -> « 1er » / « 1ère » (selon le sexe) ; sinon « 8e », « 19e »."""
    if rang is None:
        return ''
    if rang == 1:
        return '1ère' if sexe == 'F' else '1er'
    return f"{rang}e"


def nom_affiche(nom, prenom):
    """NOM en majuscules + prénom en casse titre : « DILOGA Samira »."""
    prenom = (prenom or '').strip()
    return f"{(nom or '').strip().upper()} {prenom.title()}".strip()


def abreviation_matiere(matiere):
    """Libellé court de l'en-tête : abréviation saisie, à défaut les 5
    premiers caractères du libellé."""
    court = (matiere.abreviation or '').strip() if matiere else ''
    return court or ((matiere.libelle or '').strip()[:5] if matiere else '')


def _rangs(valeurs_par_id):
    """{id: valeur|None} -> {id: rang|None}, rang = 1 + nombre de valeurs
    strictement supérieures (ex æquo au même rang). Propre au PV."""
    classees = [v for v in valeurs_par_id.values() if v is not None]
    return {cle: (None if v is None else 1 + sum(1 for autre in classees if autre > v))
            for cle, v in valeurs_par_id.items()}


def _en_float(valeur):
    return float(valeur) if valeur is not None else None


def classe_label(classe):
    cycle = classe.cycle.libelle if classe.cycle else None
    if cycle and classe.option:
        return f"{cycle} {classe.option}"
    return cycle or classe.option or f"Classe #{classe.id}"


def titre_sequence(sequence):
    """'Séquence 2' -> « CONTRÔLE CONTINU N°2 » ; sans numéro, le libellé en
    majuscules."""
    trouve = re.search(r'(\d+)\s*$', sequence.libelle or '')
    return f"CONTRÔLE CONTINU N°{trouve.group(1)}" if trouve else (sequence.libelle or '').upper()


# --- Séquences --------------------------------------------------------------

def sequences_de_l_annee(etablissement, annee_id):
    """Séquences d'une année scolaire de l'établissement, dans l'ordre
    (trimestre, séquence). Lève PvErreur 404 si l'année est introuvable."""
    annee = AnneeScolaire.query.filter_by(id=annee_id, etablissement_id=etablissement.id).first() \
        if annee_id else None
    if not annee:
        raise PvErreur("Année scolaire introuvable", 404)
    sequences = sequences_de_annee(annee.id)
    return [{"id": s.id, "libelle": s.libelle, "titre": titre_sequence(s),
             "trimestre_id": s.trimestre_id, "trimestre": s.trimestre.libelle if s.trimestre else None}
            for s in sequences]


# --- Construction du PV -----------------------------------------------------

def construire_pv(etablissement, classe_id, annee_id, sequence_id=None, ordre='alphabetique', periode=None):
    """Calcule le PV d'une classe pour une période (cf.
    trous_services.resoudre_periode) : une séquence (note de la séquence),
    une seule évaluation d'une séquence (CC, DS, Ev. Tr.) ou un trimestre
    (moyenne des séquences). periode absent : la séquence sequence_id. Lève
    PvErreur (404) si la classe, l'année ou la période est introuvable."""
    classe = Classe.query.get(classe_id) if classe_id else None
    if not classe or classe.etablissement_id != etablissement.id:
        raise PvErreur("Classe introuvable", 404)

    annee = AnneeScolaire.query.filter_by(id=annee_id, etablissement_id=etablissement.id).first() \
        if annee_id else None
    if not annee:
        raise PvErreur("Année scolaire introuvable", 404)

    if not periode:
        if not sequence_id:
            raise PvErreur("Séquence introuvable pour cette année scolaire", 404)
        periode = f"seq:{sequence_id}"
    try:
        p = resoudre_periode(periode, annee)
    except PeriodeErreur as err:
        raise PvErreur(err.message, err.status)
    if p["type"] == 'annuel':
        raise PvErreur("Le procès-verbal porte sur une séquence, une évaluation ou un trimestre")
    sequences = p["sequences"]
    sequence = sequences[0]
    seq_ids = [s.id for s in sequences]

    inscriptions = Inscription.query.filter(
        Inscription.classe_id == classe.id, Inscription.annee_scolaire_id == annee.id,
        Inscription.statut.in_(STATUTS_INSCRIPTION_EN_COURS),
    ).all()
    insc_ids = [i.id for i in inscriptions]

    matieres_classe = MatiereClasse.query.filter_by(classe_id=classe.id).all()

    # Colonnes : ordre du groupe de matières, puis libellé (insensible à la casse).
    def _cle_matiere(mc):
        groupe = mc.matiere.groupe if mc.matiere else None
        return ((groupe.ordre, groupe.libelle.lower()) if groupe else (10**9, ''),
                (mc.matiere.libelle if mc.matiere else '').lower(), mc.id)

    matieres_classe.sort(key=_cle_matiere)
    mc_ids = [mc.id for mc in matieres_classe]
    total_coef = sum(mc.coefficient for mc in matieres_classe)

    # notes_seq[(insc, mc, seq)] = (Decimal, absent) — absent = 0 (D3) ;
    # absente du dict = note manquante.
    notes_seq = {}
    if insc_ids and mc_ids:
        lignes_notes = Note.query.filter(Note.inscription_id.in_(insc_ids), Note.matiere_classe_id.in_(mc_ids),
                                         Note.sequence_id.in_(seq_ids)).all()
        if p["composante"]:
            for n in lignes_notes:
                if n.composante == p["composante"] and (n.valeur is not None or n.absent):
                    valeur = Decimal('0') if n.valeur is None else Decimal(str(n.valeur))
                    notes_seq[(n.inscription_id, n.matiere_classe_id, n.sequence_id)] = (valeur, n.valeur is None)
        else:
            for cle, ns in notes_par_sequence(lignes_notes, mode_de_annee(annee)).items():
                if ns.valeur is not None or ns.absent:
                    valeur = Decimal('0') if ns.valeur is None else Decimal(ns.valeur)
                    notes_seq[cle] = (valeur, ns.valeur is None and ns.absent)
    dispenses = dispenses_de(insc_ids, mc_ids, seq_ids)

    def _note_periode(insc_id, mc_id):
        """-> (statut, Decimal|None), statut parmi dispense, manquante, ok,
        absent : moyenne des séquences de la période (séquences dispensées
        ignorées)."""
        valeurs, tous_absents = [], True
        for s_id in seq_ids:
            if (insc_id, mc_id, s_id) in dispenses:
                continue
            trouve = notes_seq.get((insc_id, mc_id, s_id))
            if trouve is None:
                return 'manquante', None
            valeurs.append(trouve[0])
            tous_absents = tous_absents and trouve[1]
        if not valeurs:
            return 'dispense', None
        return ('absent' if tous_absents else 'ok'), sum(valeurs) / Decimal(len(valeurs))

    titulaire = TitulaireClasse.query.filter_by(classe_id=classe.id, annee_scolaire_id=annee.id).first()

    # --- Calcul par élève (Decimal partout) ---------------------------------
    lignes = []
    manquantes_par_matiere = {mc.id: 0 for mc in matieres_classe}
    for insc in inscriptions:
        total = Decimal('0')
        coef_eleve = 0
        manquantes = []
        cellules = []
        for mc in matieres_classe:
            statut, note = _note_periode(insc.id, mc.id)
            if statut in ('manquante', 'dispense'):
                if statut == 'manquante':
                    manquantes.append(mc.id)
                    manquantes_par_matiere[mc.id] += 1
                cellules.append({"mc_id": mc.id, "note": None, "points": None, "points_fmt": "", "note_fmt": "",
                                 "statut": statut, "rouge": False})
                continue
            points = note * Decimal(mc.coefficient)                               # absent = 0 (D3)
            total += points
            coef_eleve += mc.coefficient
            cellules.append({"mc_id": mc.id, "note": _en_float(note), "points": _en_float(points),
                             "points_fmt": fmt_points(points),
                             "note_fmt": fmt_points(note),
                             "statut": statut,
                             "rouge": note < SEUIL_ROUGE})                         # D5

        # Coefficients de l'élève : ceux des matières non dispensées.
        classe_ok = not manquantes and coef_eleve > 0
        moyenne_exacte = total / Decimal(coef_eleve) if classe_ok else None
        moyenne = tronquer_2(moyenne_exacte) if classe_ok else None
        motif = None
        if not classe_ok:
            motif = ("Aucune matière affectée à la classe" if total_coef == 0
                     else f"{len(manquantes)} note(s) manquante(s)" if manquantes
                     else "Dispensé de toutes les matières")
        lignes.append({"insc": insc, "cellules": cellules, "total": total, "coef": coef_eleve,
                       "exacte": moyenne_exacte, "moyenne": moyenne,
                       "classe": classe_ok, "motif": motif})

    rangs = _rangs({l["insc"].id: l["exacte"] for l in lignes})   # D2 : valeur exacte

    # --- Tri puis numérotation (le N° suit l'ordre alphabétique) -----------
    def _cle_alpha(l):
        e = l["insc"].eleve
        return (e.nom.casefold(), (e.prenom or '').casefold(), l["insc"].id)

    alphabetique = sorted(lignes, key=_cle_alpha)
    numeros = {l["insc"].id: i for i, l in enumerate(alphabetique, start=1)}
    if ordre == 'rang':
        ordonnees = sorted(lignes, key=lambda l: (rangs[l["insc"].id] is None,
                                                  rangs[l["insc"].id] or 0, _cle_alpha(l)))
    else:
        ordonnees = alphabetique

    eleves = []
    for l in ordonnees:
        insc = l["insc"]
        e = insc.eleve
        rang = rangs[insc.id]
        eleves.append({
            "numero": numeros[insc.id],
            "inscription_id": insc.id,
            "eleve_id": e.id,
            "nom": e.nom, "prenom": e.prenom, "sexe": e.sexe,
            "nom_affiche": nom_affiche(e.nom, e.prenom),
            "cellules": l["cellules"],
            "total": _en_float(l["total"]), "total_fmt": fmt_points(l["total"]),
            "total_coef": l["coef"],
            "moyenne": _en_float(l["moyenne"]), "moyenne_fmt": fmt_moyenne(l["moyenne"]),
            "moyenne_rouge": l["exacte"] is not None and l["exacte"] < SEUIL_ROUGE,
            "rang": rang, "rang_fmt": fmt_rang(rang, e.sexe) if rang is not None else "N.C.",
            "classe": l["classe"], "nc_motif": l["motif"],
        })

    # --- Statistiques et alertes --------------------------------------------
    classees = [l for l in lignes if l["classe"]]
    exactes = [l["exacte"] for l in classees]
    nb_sup_10 = sum(1 for m in exactes if m >= SEUIL_ROUGE)
    statistiques = {
        "moyenne_classe": _en_float(tronquer_2(sum(exactes) / len(exactes))) if exactes else None,
        "moyenne_min": _en_float(tronquer_2(min(exactes))) if exactes else None,
        "moyenne_max": _en_float(tronquer_2(max(exactes))) if exactes else None,
        "nb_classes": len(classees),
        "nb_sup_10": nb_sup_10,
        "nb_inf_10": len(classees) - nb_sup_10,
        "taux_reussite": round(100 * nb_sup_10 / len(classees), 1) if classees else None,
        "nb_non_classes": len(lignes) - len(classees),
    }
    statistiques["moyenne_classe_fmt"] = fmt_moyenne(tronquer_2(sum(exactes) / len(exactes))) if exactes else ""
    statistiques["moyenne_min_fmt"] = fmt_moyenne(tronquer_2(min(exactes))) if exactes else ""
    statistiques["moyenne_max_fmt"] = fmt_moyenne(tronquer_2(max(exactes))) if exactes else ""
    # Élève(s) ayant la plus forte / la plus faible moyenne (ex aequo sur la
    # valeur exacte : tous les noms, séparés par « , »).
    def _noms_extreme(valeur):
        return ", ".join(nom_affiche(l["insc"].eleve.nom, l["insc"].eleve.prenom)
                         for l in sorted(classees, key=_cle_alpha) if l["exacte"] == valeur)
    statistiques["premier"] = _noms_extreme(max(exactes)) if exactes else ""
    statistiques["dernier"] = _noms_extreme(min(exactes)) if exactes else ""
    statistiques["taux_reussite_fmt"] = (str(statistiques["taux_reussite"]).replace('.', ',')
                                         if statistiques["taux_reussite"] is not None else "")
    alertes = [{"mc_id": mc.id, "matiere": mc.matiere.libelle if mc.matiere else f"Matière #{mc.matiere_id}",
                "manquantes": manquantes_par_matiere[mc.id]}
               for mc in matieres_classe if manquantes_par_matiere[mc.id]]

    return {
        "etablissement": {
            "nom": etablissement.nom, "bp": etablissement.bp, "telephone": etablissement.telephone,
            "region": etablissement.region, "adresse": etablissement.adresse, "logo": etablissement.logo,
            "nom_bilingue": etablissement.nom_bilingue,
            # « BP 66 » / « B.P. 66 » -> « 66 » : le gabarit ajoute B.P. / P.O. Box.
            "bp_numero": re.sub(r'^\s*(B\.?\s*P\.?|P\.?\s*O\.?\s*Box)\s*', '', etablissement.bp or '', flags=re.I),
        },
        "classe": {"id": classe.id, "label": classe_label(classe)},
        "annee": {"id": annee.id, "libelle": annee.libelle},
        "sequence": {"id": sequence.id, "libelle": p["libelle"], "titre": p["titre"]},
        "periode": {"value": periode, "type": p["type"], "titre": p["titre"], "libelle": p["libelle"],
                    "composante": p["composante"], "sequence_ids": seq_ids},
        "titulaire": (f"{titulaire.enseignant.nom} {titulaire.enseignant.prenom}".strip()
                      if titulaire and titulaire.enseignant else None),
        "effectif": len(inscriptions),
        "total_coef": total_coef,
        "matieres": [{"mc_id": mc.id,
                      "libelle": mc.matiere.libelle if mc.matiere else f"Matière #{mc.matiere_id}",
                      "abreviation": abreviation_matiere(mc.matiere),
                      "coefficient": mc.coefficient,
                      "groupe": mc.matiere.groupe.libelle if mc.matiere and mc.matiere.groupe else None}
                     for mc in matieres_classe],
        "eleves": eleves,
        "statistiques": statistiques,
        "alertes": alertes,
    }
