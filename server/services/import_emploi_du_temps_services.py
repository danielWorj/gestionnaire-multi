"""Import de masse de l'emploi du temps (Horaire) depuis les archives des
établissements.

Trois présentations de fichiers sont comprises :
- « en liste » : une ligne par cours (Classe | Jour | Horaire | Matière |
  Enseignant | Salle), l'horaire pouvant aussi être en deux colonnes
  (Début | Fin) ;
- « grille de classe » : une ligne par créneau, une colonne par jour, la
  matière dans chaque case ; la classe vient du titre du tableau, du nom du
  fichier, ou de la classe par défaut ;
- « grille de professeur » (EMPLOI DU TEMPS DU PROFESSEUR) : une ligne par
  créneau, deux colonnes par jour (MATIÈRES | CLASSES) sous une ligne
  d'en-tête fusionnée LUNDI, MARDI… (cf. import_lecture : en-tête de groupe).

Un cours de l'application est une MatiereClasse (classe + matière, qui
donne l'enseignant) programmée un jour, sur un créneau, pour une année : la
matière et la classe du fichier doivent donc correspondre à une affectation
déjà enregistrée (menu Matières) — elle n'est jamais inventée. Les créneaux
horaires absents (« 7h30-8h25 ») sont créés.

Mêmes règles que la saisie manuelle (emploi_du_temps_services) : une
classe ou un enseignant n'a qu'un cours à la fois (créneaux qui se
chevauchent compris), et un Censeur/Surveillant n'importe que pour les
classes dont il a la charge.
"""

import re
from collections import Counter, defaultdict
from datetime import time
from difflib import SequenceMatcher

from extensions import db
from models.emploi_du_temps_models import CreneauHoraire, Horaire, JOURS_SEMAINE
from models.pedagogie_models import Enseignant, Matiere, MatiereClasse
from models.structure_models import AnneeScolaire, Classe, annee_active
from services.import_commun import (
    Schema, _libelles_classe, analyser_avec_schema, libelle_classe_depuis_texte, nettoyer_espaces,
    rapprocher_classe, ressemble_a_une_classe, valider_blocs,
)
from services.import_lecture import _dedoublonner, normaliser, sans_accents
from services.import_matieres_services import rapprocher_enseignant
from services.pedagogie_services import resolve_classe_ids_restriction

# import_api passe alors le rôle et l'identité de l'utilisateur à traiter().
UTILISE_CONTEXTE = True

CHAMPS = [
    ('classe', 'Classe', 'Sinon : titre du tableau, nom du fichier ou classe par défaut'),
    ('jour', 'Jour', 'Lundi … Samedi'),
    ('creneau', 'Horaire', '« 7h30-8h25 »'),
    ('heure_debut', 'Heure de début', ''),
    ('heure_fin', 'Heure de fin', ''),
    ('matiere', 'Matière', ''),
    ('enseignant', 'Enseignant', "Contrôle seulement : l'enseignant vient de l'affectation de la matière"),
    ('salle', 'Salle', ''),
    ('cours_jour', 'Matières du jour en en-tête', 'Grille : une colonne par jour'),
    ('classe_jour', 'Classes du jour en en-tête', "Grille d'un professeur : colonne « Classes » de chaque jour"),
]

SYNONYMES = {
    'numero': ['n', 'no', 'num', 'numero', 'n d ordre', 'ordre'],
    'classe': ['classe', 'classes', 'division', 'cl', 'niveau'],
    'jour': ['jour', 'jours', 'day', 'jour de la semaine'],
    'creneau': ['horaire', 'horaires', 'horraire', 'horraires', 'heure', 'heures', 'creneau', 'creneaux',
                'creneau horaire', 'plage horaire', 'tranche horaire', 'periode', 'time'],
    'heure_debut': ['debut', 'heure de debut', 'heure debut', 'de', 'start'],
    'heure_fin': ['fin', 'heure de fin', 'heure fin', 'a', 'end'],
    'matiere': ['matiere', 'matieres', 'discipline', 'disciplines', 'cours', 'enseignement', 'subject'],
    'enseignant': ['enseignant', 'enseignants', 'professeur', 'professeurs', 'prof', 'intervenant'],
    'salle': ['salle', 'local', 'salle de cours', 'lieu'],
}

_JOURS = {
    'lundi': 'Lundi', 'monday': 'Lundi', 'lun': 'Lundi', 'mardi': 'Mardi', 'tuesday': 'Mardi',
    'mercredi': 'Mercredi', 'wednesday': 'Mercredi', 'mer': 'Mercredi', 'jeudi': 'Jeudi', 'thursday': 'Jeudi',
    'jeu': 'Jeudi', 'vendredi': 'Vendredi', 'friday': 'Vendredi', 'ven': 'Vendredi', 'samedi': 'Samedi',
    'saturday': 'Samedi', 'sam': 'Samedi',
}
_JOUR_RE = re.compile(r'\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|monday|tuesday|wednesday|thursday|friday|saturday)\b')
_PAUSE_RE = re.compile(r'\b(pause|recreation|recre|break|dejeuner|repas|libre)\b')
_PLAGE_RE = re.compile(r'^\d{1,2}\s*[h:.]\s*\d{0,2}\s*[-–—a/]')
_CHAMPS_GRILLE = ('cours_jour', 'classe_jour')

LIMITE_SALLE = 30
LIMITE_LIBELLE_CRENEAU = 50


def parser_jour(texte):
    n = normaliser(texte)
    m = _JOUR_RE.search(n)
    if m:
        return _JOURS[m.group(1)]
    return _JOURS.get(n)


def _heure(jeton):
    """« 7h30 », « 07:30 », « 8h », « 1455 », « 0.3125 » (Excel) -> time | None."""
    t = jeton.strip()
    m = re.fullmatch(r'0?\.\d+', t)
    if m:
        minutes = round(float(t) * 1440)
        h, mi = divmod(minutes, 60)
    else:
        m = re.fullmatch(r'(\d{1,2})[h:.](\d{2})', t) or re.fullmatch(r'(\d{1,2})h?()', t) \
            or re.fullmatch(r'(\d{1,2})(\d{2})', t)
        if not m:
            return None
        h, mi = int(m.group(1)), int(m.group(2) or 0)
    if h > 23 or mi > 59:
        return None
    return time(h, mi)


def parser_creneau(texte):
    """« 7h30-8h25 », « 07:30 - 08:25 », « 14h00-1455 », « de 8h à 9h »
    -> (début, fin) | None."""
    t = sans_accents(texte or '').lower()
    t = re.sub(r'(\d{1,2}:\d{2}):\d{2}', r'\1', t)
    t = re.sub(r'\s+', '', t)
    jetons = re.findall(r'\d{1,2}[h:.]\d{2}|\d{1,2}h|\d{3,4}|0?\.\d+|\d{1,2}', t)
    if len(jetons) < 2:
        return None
    debut, fin = _heure(jetons[0]), _heure(jetons[1])
    if not debut or not fin or debut >= fin:
        return None
    return debut, fin


def libelle_creneau(debut, fin):
    return f"{debut.strftime('%Hh%M')}-{fin.strftime('%Hh%M')}"


def _exclure(champ, n):
    # « LUNDI MATIERES » est une colonne de grille, pas la colonne « Matière ».
    return bool(_JOUR_RE.search(n)) and champ not in _CHAMPS_GRILLE


def _profil(valeurs):
    vals = [v for v in valeurs if v][:200]
    if not vals:
        return {}
    total = len(vals)
    scores = {}
    if sum(1 for v in vals if parser_creneau(v)) >= 0.6 * total:
        scores['creneau'] = 0.8
    if sum(1 for v in vals if parser_jour(v)) >= 0.8 * total:
        scores['jour'] = 0.8
    return scores


def _scores_grille(cle, col):
    if not _JOUR_RE.search(cle):
        return {}
    if re.search(r'\b(classe|classes|division|cl)\b', cle):
        return {'classe_jour': 0.95}
    return {'cours_jour': 0.9}


SCHEMA = Schema(CHAMPS, SYNONYMES, exclure=_exclure, profil=_profil, multiples=_CHAMPS_GRILLE,
                mot_cle_extra=lambda texte: parser_jour(texte) is not None)


def _fusionner_entete_groupe(bloc):
    """Grille de professeur : « LUNDI » (fusionné) au-dessus de
    « MATIERES | CLASSES » -> colonnes « LUNDI MATIERES », « LUNDI CLASSES »."""
    groupe = bloc.get('entetes_groupe')
    if not groupe or sum(1 for g in set(groupe) if parser_jour(g)) < 2:
        return
    entetes = []
    for entete, g in zip(bloc['entetes'], groupe):
        base = re.sub(r'\s\(\d+\)$', '', entete)
        if re.fullmatch(r'Colonne \d+', base):
            entetes.append(g or entete)
        elif g and normaliser(g) != normaliser(base) and not parser_jour(base):
            entetes.append(f'{g} {base}')
        else:
            entetes.append(base)
    bloc['entetes'] = _dedoublonner(entetes)


def est_tableau_edt(bloc):
    entetes = [normaliser(e) for e in bloc['entetes']]
    if sum(1 for e in entetes if _JOUR_RE.search(e)) >= 2:
        return True
    a_horaire = any(SCHEMA.score('creneau', e) >= 0.6 or SCHEMA.score('heure_debut', e) >= 0.6 for e in entetes)
    a_jour = any(SCHEMA.score('jour', e) >= 0.6 for e in entetes)
    a_matiere = any(SCHEMA.score('matiere', e) >= 0.6 for e in entetes)
    return a_horaire and (a_jour or a_matiere)


def analyser_fichiers(fichiers, texte_colle=None):
    return analyser_avec_schema(fichiers, texte_colle, SCHEMA, pertinence=est_tableau_edt,
                                preparer=_fusionner_entete_groupe)


# ---------------------------------------------------------------------------
# Rapprochements
# ---------------------------------------------------------------------------

_MOTS_VIDES = {'et', 'de', 'des', 'du', 'la', 'le', 'les', 'l', 'd', 'en', 'a', 'au', 'aux'}
_CIVILITE_DANS_CASE = re.compile(r'\b(m|mr|mme|mlle|dr|prof)\b.*$')


def _texte_matiere(texte):
    """« MATHS M. ABENG », « Français (salle 3) » -> « maths », « francais »."""
    n = normaliser(re.sub(r'\(.*?\)', ' ', texte or ''))
    return _CIVILITE_DANS_CASE.sub('', n).strip() or n


def score_matiere(texte, libelle):
    """Ressemblance entre une matière écrite dans un emploi du temps (souvent
    abrégée : « MATHS COM », « TCFE », « Hist-Géo ») et un libellé de
    l'application."""
    a, b = _texte_matiere(texte), normaliser(libelle)
    if not a or not b:
        return 0.0
    if a == b or a.replace(' ', '') == b.replace(' ', ''):
        return 1.0
    ta = a.split()
    significatifs = [w for w in b.split() if w not in _MOTS_VIDES] or b.split()
    # Sigle : « TCFE », « SVT », « EPS », « ECM »
    if len(ta) == 1 and len(significatifs) >= 2 and ta[0] == ''.join(w[0] for w in significatifs):
        return 0.9
    # Mots abrégés dans l'ordre : « MATHS COM » = « Mathématiques commerciales »
    if len(ta) <= len(significatifs):
        i, ok = 0, True
        for mot in ta:
            prefixe = mot[:-1] if len(mot) > 4 and mot.endswith('s') else mot
            while i < len(significatifs) and not significatifs[i].startswith(prefixe):
                i += 1
            if i == len(significatifs):
                ok = False
                break
            i += 1
        if ok:
            return 0.88 if len(ta) == len(significatifs) else 0.8
    ratio = SequenceMatcher(None, a, b).ratio()
    return ratio * 0.9 if ratio >= 0.85 else 0.0


def rapprocher_matiere(texte, matieres, preferees=()):
    """Matière unique la plus proche, ou None. preferees : ids des matières
    affectées aux classes où ce texte apparaît (départage les ex aequo)."""
    meilleur, score_max, ex_aequo = None, 0.0, False
    for m in matieres:
        score = score_matiere(texte, m.libelle)
        if not score:
            continue
        if m.id in preferees:
            score += 0.05
        if score > score_max + 1e-9:
            meilleur, score_max, ex_aequo = m.id, score, False
        elif abs(score - score_max) < 1e-9:
            ex_aequo = True
    return meilleur if score_max >= 0.8 and not ex_aequo else None


def _morceaux(texte):
    return [m for m in re.split(r'\s*[/,;+&]\s*', texte or '') if m.strip()]


def decouper_matiere(texte, matieres, choix_utilisateur):
    """« CGAO/GSO » (deux cours) -> ['CGAO', 'GSO'] ; mais « HIST/GEO » reste
    entier s'il désigne une seule matière. On ne découpe que si le texte
    entier n'est pas reconnu et que chaque morceau l'est."""
    morceaux = _morceaux(texte)
    if len(morceaux) < 2 or texte in choix_utilisateur or rapprocher_matiere(texte, matieres):
        return [texte] if texte else []
    if all(m in choix_utilisateur or rapprocher_matiere(m, matieres) for m in morceaux):
        return morceaux
    return [texte]


def resoudre_classes(texte, classes_app):
    """Texte d'une case « Classe » -> liste d'ids de classes. Gère les cours
    communs écrits « ESCOM4/ESF4 » ou collés « ESF3ESCOM3 »."""
    texte = nettoyer_espaces(texte)
    if not texte:
        return []
    trouve = rapprocher_classe(texte, classes_app)
    if trouve:
        return [trouve]
    for morceaux in (_morceaux(texte), re.split(r'(?<=\d)\s*(?=[A-Za-z]{2})', texte)):
        if len(morceaux) > 1:
            ids = [rapprocher_classe(m, classes_app) for m in morceaux]
            if all(ids):
                return ids
    return []


_MOTS_TITRE_EDT = re.compile(r'(?i)\b(emplois?|temps|e\.?d\.?t|horaires?|professeurs?|classe)\b')


def _classe_du_titre(bloc):
    """« EMPLOI DU TEMPS DE LA 6e A » (titre ou nom de fichier) -> « 6E A »."""
    for texte in (bloc.get('contexte'), bloc.get('classe_detectee')):
        candidat = libelle_classe_depuis_texte(_MOTS_TITRE_EDT.sub(' ', sans_accents(texte or '')))
        if candidat and ressemble_a_une_classe(candidat):
            return candidat
    return ''


# ---------------------------------------------------------------------------
# Traitement
# ---------------------------------------------------------------------------

def _vers_id(valeur, valides):
    try:
        v = int(valeur)
    except (TypeError, ValueError):
        return None
    return v if v in valides else None


def _options(brutes):
    o = dict(brutes or {})
    return {
        'annee_scolaire_id': o.get('annee_scolaire_id'),
        'classe_defaut': o.get('classe_defaut'),
        'creer_creneaux': bool(o.get('creer_creneaux', True)),
        'remplacer': bool(o.get('remplacer', False)),
        'classes': {str(k): v for k, v in (o.get('classes') or {}).items()},
        'matieres': {str(k): v for k, v in (o.get('matieres') or {}).items()},
    }


def _cours_bruts(lues, mapping):
    """Une ligne du fichier -> cours bruts (un par jour en grille) :
    (id, source, jour texte, créneau texte, matière, classe, enseignant, salle, bloc)."""
    champs = set(mapping.values())
    grille = bool(champs & set(_CHAMPS_GRILLE))
    for rid, source, v, multiples, bloc in lues:
        if v.get('creneau'):
            creneau = v['creneau']
        elif v.get('heure_debut') or v.get('heure_fin'):
            creneau = f"{v.get('heure_debut', '')}-{v.get('heure_fin', '')}"
        else:
            creneau = ''
        if _PAUSE_RE.search(normaliser(creneau)):
            continue
        if not grille:
            if (v.get('matiere') or v.get('classe')) and not _PAUSE_RE.search(normaliser(v.get('matiere', ''))):
                yield (rid, source, v.get('jour', ''), creneau, v.get('matiere', ''), v.get('classe', ''),
                       v.get('enseignant', ''), v.get('salle', ''), bloc)
            continue
        par_jour = defaultdict(lambda: ([], []))
        for k, champ in enumerate(_CHAMPS_GRILLE):
            for entete, valeur in multiples.get(champ, []):
                par_jour[parser_jour(entete) or entete][k].append(valeur)
        for jour, (matieres, classes) in par_jour.items():
            for k in range(max(len(matieres), len(classes))):
                matiere = matieres[k] if k < len(matieres) else ''
                classe = classes[k] if k < len(classes) else (v.get('classe', ''))
                if _PAUSE_RE.search(normaliser(matiere)) and not classe:
                    continue
                yield (f'{rid}:{jour}:{k}', source, jour, creneau, matiere, classe,
                       v.get('enseignant', ''), v.get('salle', ''), bloc)


def traiter(etablissement_id, payload, valider=False, contexte=None):
    erreur = valider_blocs(payload)
    if erreur:
        return {'erreur': erreur}, 400
    blocs = payload['blocs']
    options = _options(payload.get('options'))
    exclues = set(payload.get('exclues') or [])
    corrections = payload.get('corrections') or {}
    contexte = contexte or {}
    restriction = resolve_classe_ids_restriction(contexte.get('role'), contexte.get('user_id'))

    mapping_suggere, colonnes = SCHEMA.suggerer(blocs, _scores_grille)
    mapping = payload.get('mapping')
    if not isinstance(mapping, dict):
        mapping = mapping_suggere
    mapping = {cle: champ for cle, champ in mapping.items() if champ in SCHEMA.cles}
    for col in colonnes:
        col['champ'] = mapping.get(col['cle'], '')

    # --- Référentiels --------------------------------------------------------
    annees = AnneeScolaire.query.filter_by(etablissement_id=etablissement_id).all()
    annee = next((a for a in annees if a.id == _vers_id(options['annee_scolaire_id'], {a.id for a in annees})), None) \
        or annee_active(etablissement_id)
    if annee is None:
        return {'erreur': "Aucune année scolaire : créez-en une dans Configuration avant d'importer l'emploi du temps."}, 400
    classes = Classe.query.filter_by(etablissement_id=etablissement_id).all()
    hors_perimetre = {}
    if restriction is not None:
        hors_perimetre = {c.id: _libelles_classe(c) for c in classes if c.id not in restriction}
        classes = [c for c in classes if c.id in restriction]
    classes_app = {c.id: _libelles_classe(c) for c in classes}
    matieres = Matiere.query.filter_by(etablissement_id=etablissement_id).all()
    matiere_par_id = {m.id: m for m in matieres}
    enseignants = Enseignant.query.filter_by(etablissement_id=etablissement_id).all()
    ens_par_id = {e.id: e for e in enseignants}
    mc_par_couple = {(mc.classe_id, mc.matiere_id): mc for mc in
                     MatiereClasse.query.join(Classe, MatiereClasse.classe_id == Classe.id)
                     .filter(Classe.etablissement_id == etablissement_id).all()}
    matieres_par_classe = defaultdict(set)
    for (classe_id, matiere_id) in mc_par_couple:
        matieres_par_classe[classe_id].add(matiere_id)
    creneaux = CreneauHoraire.query.filter_by(etablissement_id=etablissement_id).all()
    creneau_par_heures = {(c.heure_debut, c.heure_fin): c for c in creneaux}
    existants = (Horaire.query
                 .join(MatiereClasse, Horaire.matiere_classe_id == MatiereClasse.id)
                 .join(Classe, MatiereClasse.classe_id == Classe.id)
                 .filter(Classe.etablissement_id == etablissement_id, Horaire.annee_scolaire_id == annee.id).all())
    classe_defaut = _vers_id(options['classe_defaut'], classes_app)

    # --- Première passe : cours bruts, classes et matières citées ------------
    lues = list(SCHEMA.lignes(blocs, mapping))
    bruts = []
    classes_citees, matieres_citees = Counter(), Counter()
    classes_du_texte = defaultdict(set)
    corr_classes = {}

    def classes_de(texte):
        if texte not in corr_classes:
            if texte in options['classes']:
                choix = _vers_id(options['classes'][texte], classes_app)
                corr_classes[texte] = ([choix] if choix else [], False)
            else:
                ids = resoudre_classes(texte, classes_app)
                corr_classes[texte] = (ids, bool(ids))
        return corr_classes[texte][0]

    for cid, source, jour, creneau, matiere, classe, enseignant, salle, bloc in _cours_bruts(lues, mapping):
        if not classe:
            classe = _classe_du_titre(bloc)
        if classe:
            classes_citees[classe] += 1
        ids = classes_de(classe) if classe else ([classe_defaut] if classe_defaut else [])
        morceaux = _morceaux(matiere)
        if not (len(ids) > 1 and len(morceaux) == len(ids)):    # « CGAO/GSO » + « ESCOM4/ESF4 »
            morceaux = decouper_matiere(matiere, matieres, options['matieres'])
        for morceau in morceaux:
            matieres_citees[morceau] += 1
            classes_du_texte[morceau].update(ids)
        bruts.append((cid, source, jour, creneau, morceaux or [''], classe, ids, enseignant, salle))

    classes_detectees = [{'libelle': t, 'nb': nb, 'classe_ids': corr_classes[t][0],
                          'classe_id': corr_classes[t][0][0] if len(corr_classes[t][0]) == 1 else None,
                          'suggere': corr_classes[t][1]} for t, nb in sorted(classes_citees.items())]
    corr_matieres, matieres_detectees = {}, []
    for texte, nb in sorted(matieres_citees.items()):
        if texte in options['matieres']:
            choix, suggere = _vers_id(options['matieres'][texte], matiere_par_id), False
        else:
            preferees = set().union(*(matieres_par_classe[c] for c in classes_du_texte[texte])) \
                if classes_du_texte[texte] else set()
            choix = rapprocher_matiere(texte, matieres, preferees)
            suggere = choix is not None
        corr_matieres[texte] = choix
        matieres_detectees.append({'libelle': texte, 'nb': nb, 'matiere_id': choix, 'suggere': suggere})

    # --- Deuxième passe : un cours par ligne d'aperçu -------------------------
    resultats = []
    for cid, source, jour_txt, creneau_txt, morceaux_mat, classe_txt, classe_ids, ens_txt, salle in bruts:
        if len(classe_ids) > 1 and len(morceaux_mat) == len(classe_ids):
            couples = list(zip(classe_ids, morceaux_mat))            # « CGAO/GSO » + « ESCOM4/ESF4 »
        elif len(classe_ids) > 1:
            couples = [(c, morceaux_mat[0]) for c in classe_ids]   # cours commun à plusieurs classes
        elif len(morceaux_mat) > 1:
            couples = [(classe_ids[0] if classe_ids else None, m) for m in morceaux_mat]
        else:
            couples = [(classe_ids[0] if classe_ids else None, morceaux_mat[0])]
        for k, (classe_id, mat_txt) in enumerate(couples):
            rid = cid if len(couples) == 1 else f'{cid}:{k}'
            r = {'id': rid, 'source': source, 'erreurs': [], 'avertissements': [], 'statut': 'nouveau'}
            if rid in exclues:
                r['statut'] = 'exclu'
            corr = corrections.get(rid) or {}
            matiere_id = corr_matieres.get(mat_txt)
            if corr.get('classe_id'):
                classe_id = _vers_id(corr['classe_id'], classes_app)
            if corr.get('matiere_id'):
                matiere_id = _vers_id(corr['matiere_id'], matiere_par_id)
            jour = parser_jour(corr['jour']) if corr.get('jour') else parser_jour(jour_txt)
            creneau_txt = corr['creneau'] if corr.get('creneau') else creneau_txt
            salle = nettoyer_espaces(corr['salle'] if 'salle' in corr else salle)
            heures = parser_creneau(creneau_txt)

            if not jour:
                r['erreurs'].append(f"Jour non reconnu « {jour_txt} »" if jour_txt else "Jour manquant")
            if not heures:
                r['erreurs'].append(f"Horaire illisible « {creneau_txt} »" if creneau_txt else "Horaire manquant")
            if classe_id is None:
                if classe_txt and hors_perimetre and rapprocher_classe(classe_txt, hors_perimetre):
                    r['erreurs'].append(f"Classe « {classe_txt} » non assignée : vous n'en avez pas la charge")
                elif classe_txt:
                    r['erreurs'].append(f"Classe « {classe_txt} » non associée")
                else:
                    r['erreurs'].append("Classe inconnue : choisissez une classe par défaut")
            if matiere_id is None:
                r['erreurs'].append(f"Matière « {mat_txt} » non associée" if mat_txt else "Matière manquante")
            mc = mc_par_couple.get((classe_id, matiere_id)) if classe_id and matiere_id else None
            if classe_id and matiere_id and mc is None:
                r['erreurs'].append(f"« {matiere_par_id[matiere_id].libelle} » n'est pas affectée à la classe "
                                    f"« {classes_app[classe_id][0]} » (menu Matières)")
            if len(salle) > LIMITE_SALLE:
                r['avertissements'].append(f"Salle tronquée à {LIMITE_SALLE} caractères")
                salle = salle[:LIMITE_SALLE]
            creneau = creneau_par_heures.get(heures) if heures else None
            if heures and creneau is None and not options['creer_creneaux']:
                r['erreurs'].append(f"Créneau {libelle_creneau(*heures)} absent : autorisez la création des créneaux")
            if mc and ens_txt:
                cite = rapprocher_enseignant(ens_txt, enseignants)
                titulaire = ens_par_id.get(mc.enseignant_id)
                if cite and titulaire and cite.id != titulaire.id:
                    r['avertissements'].append(f"Le fichier cite {ens_txt}, mais la matière est affectée à "
                                               f"{titulaire.nom} {titulaire.prenom}".strip())
            if r['erreurs'] and r['statut'] != 'exclu':
                r['statut'] = 'erreur'

            ens = ens_par_id.get(mc.enseignant_id) if mc else None
            r['donnees'] = {
                'jour': jour or jour_txt, 'creneau': libelle_creneau(*heures) if heures else creneau_txt,
                'classe': classes_app[classe_id][0] if classe_id else classe_txt,
                'matiere': matiere_par_id[matiere_id].libelle if matiere_id else mat_txt,
                'matiere_fichier': mat_txt, 'enseignant': f'{ens.nom} {ens.prenom}'.strip() if ens else '',
                'salle': salle, 'creneau_nouveau': bool(heures) and creneau is None,
            }
            r['_cle'] = (mc, jour, heures, salle) if mc and jour and heures else None
            r['classe_id'], r['matiere_id'] = classe_id, matiere_id
            resultats.append(r)

    # --- Collisions (fichier et emploi du temps déjà enregistré) -------------
    classes_remplacees = {r['_cle'][0].classe_id for r in resultats
                          if r['_cle'] and r['statut'] == 'nouveau'} if options['remplacer'] else set()
    occupe_classe, occupe_ens = defaultdict(list), defaultdict(list)
    deja = {}
    for h in existants:
        mc = h.matiere_classe
        if mc.classe_id in classes_remplacees:
            continue
        cre = h.creneau
        info = (cre.heure_debut, cre.heure_fin, f"{matiere_par_id[mc.matiere_id].libelle if mc.matiere_id in matiere_par_id else 'cours'} (déjà enregistré)", h.matiere_classe_id)
        occupe_classe[(mc.classe_id, h.jour_semaine)].append(info)
        occupe_ens[(mc.enseignant_id, h.jour_semaine)].append(info)
        deja[(h.matiere_classe_id, h.jour_semaine, cre.heure_debut, cre.heure_fin)] = 'base'

    def chevauche(liste, debut, fin):
        return next((x for x in liste if x[0] < fin and x[1] > debut), None)

    for r in resultats:
        if r['statut'] != 'nouveau' or not r['_cle']:
            continue
        mc, jour, (debut, fin), _salle = r['_cle']
        cle = (mc.id, jour, debut, fin)
        if cle in deja:
            r['statut'] = 'existant'
            if deja[cle] != 'base':
                r['avertissements'].append(f"Cours déjà présent plus haut ({deja[cle]})")
            continue
        conflit = chevauche(occupe_classe[(mc.classe_id, jour)], debut, fin)
        if conflit:
            r['erreurs'].append(f"La classe a déjà un cours sur ce créneau : {conflit[2]}")
        else:
            conflit = chevauche(occupe_ens[(mc.enseignant_id, jour)], debut, fin)
            if conflit:
                r['erreurs'].append(f"L'enseignant a déjà un cours sur ce créneau : {conflit[2]}")
        if r['erreurs']:
            r['statut'] = 'erreur'
            continue
        info = (debut, fin, f"{r['donnees']['matiere']} – {r['donnees']['classe']} ({r['source']})", mc.id)
        occupe_classe[(mc.classe_id, jour)].append(info)
        occupe_ens[(mc.enseignant_id, jour)].append(info)
        deja[cle] = r['source']

    nb_supprimes = sum(1 for h in existants if h.matiere_classe.classe_id in classes_remplacees)
    resume = Counter(r['statut'] for r in resultats)
    actifs = [r for r in resultats if r['statut'] == 'nouveau']
    reponse = {
        'colonnes': colonnes,
        'mapping': mapping,
        'mapping_suggere': mapping_suggere,
        'champs': SCHEMA.description_champs(),
        'annees': [{'id': a.id, 'libelle': a.libelle, 'active': bool(a.active)} for a in sorted(annees, key=lambda a: a.libelle)],
        'annee_scolaire_id': annee.id,
        'classes': sorted(({'id': cid, 'libelle': lib[0]} for cid, lib in classes_app.items()), key=lambda c: c['libelle']),
        'matieres': sorted(({'id': m.id, 'libelle': m.libelle} for m in matieres), key=lambda m: m['libelle']),
        'classes_detectees': classes_detectees,
        'matieres_detectees': matieres_detectees,
        'lignes': [{k: v for k, v in r.items() if k != '_cle'} for r in resultats],
        'resume': {
            'total': len(resultats),
            'nouveaux': resume['nouveau'], 'mises_a_jour': 0, 'existants': resume['existant'],
            'erreurs': resume['erreur'], 'exclus': resume['exclu'],
            'creneaux_nouveaux': len({r['_cle'][2] for r in actifs if r['donnees']['creneau_nouveau']}),
            'horaires_supprimes': nb_supprimes,
            'classes_remplacees': len(classes_remplacees),
            'avertissements': sum(1 for r in resultats if r['avertissements'] and r['statut'] not in ('erreur', 'exclu')),
        },
    }
    if not valider:
        return reponse, 200

    try:
        bilan = Counter()
        if classes_remplacees:
            for h in existants:
                if h.matiere_classe.classe_id in classes_remplacees:
                    db.session.delete(h)
                    bilan['horaires_supprimes'] += 1
            db.session.flush()
        for r in actifs:
            mc, jour, heures, salle = r['_cle']
            creneau = creneau_par_heures.get(heures)
            if creneau is None:
                creneau = CreneauHoraire(etablissement_id=etablissement_id, libelle=libelle_creneau(*heures)[:LIMITE_LIBELLE_CRENEAU],
                                         heure_debut=heures[0], heure_fin=heures[1])
                db.session.add(creneau)
                db.session.flush()
                creneau_par_heures[heures] = creneau
                bilan['creneaux_crees'] += 1
            db.session.add(Horaire(matiere_classe_id=mc.id, annee_scolaire_id=annee.id, jour_semaine=jour,
                                   creneau_id=creneau.id, salle=salle or None))
            bilan['horaires_crees'] += 1
        db.session.commit()
    except Exception as exc:  # pragma: no cover - remonté proprement à l'utilisateur
        db.session.rollback()
        return {'erreur': f"L'import a échoué, rien n'a été enregistré : {exc}"}, 500
    reponse['bilan'] = dict(bilan)
    return reponse, 200


def generer_modele_xlsx():
    from services.import_modeles import modele_xlsx
    return modele_xlsx(
        'Emploi du temps',
        ['Classe', 'Jour', 'Horaire', 'Matière', 'Enseignant', 'Salle'],
        [['6e A', 'Lundi', '07h30-08h25', 'Mathématiques', 'ABENG Marie', 'Salle 1'],
         ['6e A', 'Lundi', '08h25-09h20', 'Anglais', 'AKAMBA Paul', 'Salle 1']],
        largeurs=(14, 12, 16, 26, 26, 14),
        listes={'B': list(JOURS_SEMAINE)},
        aide=[
            "• Une ligne par cours. Vous pouvez supprimer les lignes d'exemple.",
            "• La matière doit déjà être affectée à la classe (menu Matières) : c'est cette affectation qui donne l'enseignant.",
            "• Horaire au format 07h30-08h25 (ou deux colonnes Début / Fin). Les créneaux absents de l'application sont créés.",
            "• Une classe ou un enseignant ne peut avoir qu'un cours à la fois : les conflits sont signalés avant l'import.",
            "• Vos grilles existantes sont aussi acceptées : une colonne par jour (grille de classe), ou "
            "« EMPLOI DU TEMPS DU PROFESSEUR » avec MATIÈRES / CLASSES sous chaque jour.",
        ],
    )
