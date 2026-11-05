"""Briques communes aux imports de masse (élèves, enseignants, classes,
matières) : normalisation des valeurs (sexe, dates, noms, téléphones),
rapprochement des classes, et moteur générique de correspondance
« colonnes du fichier -> champs de l'application ».

Aucune dépendance payante : difflib (standard) pour les rapprochements
approximatifs.
"""

import re
from collections import Counter, defaultdict
from datetime import date, timedelta
from difflib import SequenceMatcher

from services.import_lecture import normaliser, sans_accents

SEXE_M = {'m', 'masculin', 'masc', 'mas', 'g', 'garcon', 'garcons', 'h', 'homme', 'male', 'boy', 'mr', 'monsieur', 'gars'}
SEXE_F = {'f', 'feminin', 'fem', 'fille', 'filles', 'femme', 'female', 'girl', 'mme', 'mlle', 'madame'}

MOIS = {
    'janvier': 1, 'janv': 1, 'jan': 1, 'january': 1, 'fevrier': 2, 'fev': 2, 'fevr': 2, 'feb': 2, 'february': 2,
    'mars': 3, 'mar': 3, 'march': 3, 'avril': 4, 'avr': 4, 'apr': 4, 'april': 4, 'mai': 5, 'may': 5,
    'juin': 6, 'jun': 6, 'june': 6, 'juillet': 7, 'juil': 7, 'jul': 7, 'july': 7, 'aout': 8, 'aou': 8,
    'aug': 8, 'august': 8, 'septembre': 9, 'sept': 9, 'sep': 9, 'september': 9, 'octobre': 10, 'oct': 10,
    'october': 10, 'novembre': 11, 'nov': 11, 'november': 11, 'decembre': 12, 'dec': 12, 'december': 12,
}

# ---------------------------------------------------------------------------
# Normalisation des valeurs
# ---------------------------------------------------------------------------

def parser_sexe(valeur):
    n = normaliser(valeur)
    if not n:
        return None
    if n in SEXE_M:
        return 'M'
    if n in SEXE_F:
        return 'F'
    premier = n.split()[0]
    if premier in SEXE_M:
        return 'M'
    if premier in SEXE_F:
        return 'F'
    return False  # renseigné mais incompréhensible


def _annee_complete(annee):
    if annee >= 100:
        return annee
    pivot = date.today().year % 100
    return 2000 + annee if annee <= pivot else 1900 + annee


def parser_date(valeur):
    """-> (date | None, avertissement | None). Ordre jour/mois privilégié."""
    v = (valeur or '').strip()
    if not v:
        return None, None
    n = sans_accents(v).lower()

    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', n)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))), None
        except ValueError:
            return None, f"Date de naissance invalide « {v} »"

    m = re.search(r'(?<!\d)(\d{4})\s*[/.]\s*(\d{1,2})\s*[/.]\s*(\d{1,2})(?!\d)', n)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))), None
        except ValueError:
            return None, f"Date de naissance invalide « {v} »"

    m = re.search(r'(?<!\d)(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2,4})(?!\d)', n)
    if m:
        j, mo, a = int(m.group(1)), int(m.group(2)), _annee_complete(int(m.group(3)))
        alerte = None
        if mo > 12 and j <= 12:
            j, mo = mo, j
            alerte = f"Date « {v} » lue au format mois/jour"
        try:
            return date(a, mo, j), alerte
        except ValueError:
            return None, f"Date de naissance invalide « {v} »"

    m = re.search(r'(\d{1,2})(?:er)?\s+([a-z]+)\.?\s+(\d{2,4})', n)
    if m and m.group(2) in MOIS:
        try:
            return date(_annee_complete(int(m.group(3))), MOIS[m.group(2)], int(m.group(1))), None
        except ValueError:
            return None, f"Date de naissance invalide « {v} »"

    if re.fullmatch(r'\d{8}', n):
        try:
            return date(int(n[4:]), int(n[2:4]), int(n[:2])), None
        except ValueError:
            pass

    if re.fullmatch(r'\d{5}(\.\d+)?', n):
        # Numéro de série Excel (jours depuis le 30/12/1899).
        serie = int(float(n))
        if 3000 < serie < 80000:
            return date(1899, 12, 30) + timedelta(days=serie), None

    m = re.search(r'\b(19|20)\d{2}\b', n)
    if m:
        return None, f"Date incomplète « {v} » : seule l'année est connue, date non enregistrée"
    return None, f"Date de naissance non reconnue « {v} »"


def separer_date_lieu(valeur):
    """« 12/03/2010 à Bafia », « Né le 12 mars 2010 à Bafia », « Bafia, le 12/03/2010 »."""
    v = (valeur or '').strip()
    if not v:
        return '', ''
    n = sans_accents(v)
    motif = re.compile(r'(\d{1,2}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|'
                       r'\d{1,2}(?:er)?\s+[A-Za-z]+\.?\s+\d{2,4})')
    m = motif.search(n)
    if not m:
        return '', v
    partie_date = v[m.start():m.end()]
    reste = (v[:m.start()] + ' ' + v[m.end():])
    reste = re.sub(r'(?i)\b(n[ée]+\s*\(?e?\)?\s*le|le|vers|[àa]|au|en)\b', ' ', sans_accents(reste))
    reste = re.sub(r'^[\s,;:\-/]+|[\s,;:\-/]+$', '', re.sub(r'\s+', ' ', reste))
    # On récupère la casse/accents d'origine si possible.
    lieu_origine = re.sub(r'\s+', ' ', v.replace(partie_date, ' ')).strip(' ,;:-/')
    lieu_origine = re.sub(r'(?i)^(n[ée]+\s*\(?e?\)?\s*le|le|vers)\s+', '', lieu_origine)
    lieu_origine = re.sub(r'(?i)^(à|a|au|en)\s+', '', lieu_origine).strip(' ,;:-/')
    lieu = lieu_origine if normaliser(lieu_origine) == normaliser(reste) else reste
    return partie_date, lieu


def nettoyer_espaces(texte):
    return re.sub(r'\s+', ' ', (texte or '').replace(' ', ' ')).strip(' ,;')


def casse_prenom(texte):
    def mot(m):
        w = m.group(0)
        return w[:1].upper() + w[1:].lower()
    return re.sub(r"[^\W\d_]+", mot, texte)


def separer_nom_complet(texte, mode):
    """-> (nom, prenom). Modes : 'premier' (1er mot = nom), 'deux' (2 premiers
    mots = nom), 'dernier' (dernier mot = prénom). Quel que soit le mode :
    une virgule sépare explicitement nom et prénom, et en casse mixte
    (« ABALA MBOUNDA Joseph ») les mots en MAJUSCULES forment le nom."""
    texte = nettoyer_espaces(texte)
    if not texte:
        return '', ''
    if ',' in texte:
        a, b = texte.split(',', 1)
        return nettoyer_espaces(a), nettoyer_espaces(b)
    mots = texte.split(' ')
    if len(mots) == 1:
        return mots[0], ''
    lettres = [re.sub(r'[^\w]', '', w) for w in mots]
    majuscules = [w.isupper() and len(w) > 1 for w in lettres]
    if any(majuscules) and not all(majuscules) and majuscules[0]:
        k = majuscules.index(False)
        if all(not x for x in majuscules[k:]):
            return ' '.join(mots[:k]), ' '.join(mots[k:])
    if mode == 'deux' and len(mots) >= 3:
        return ' '.join(mots[:2]), ' '.join(mots[2:])
    if mode == 'dernier':
        return ' '.join(mots[:-1]), mots[-1]
    return mots[0], ' '.join(mots[1:])


def normaliser_matricule(valeur):
    v = re.sub(r'\s+', '', (valeur or '')).upper()
    return re.sub(r'\.0$', '', v)


def chiffres_telephone(valeur):
    d = re.sub(r'\D', '', valeur or '')
    return d[-9:] if len(d) >= 9 else d


def premier_telephone(valeur):
    """« 699 10 35 70 / 677 00 00 00 » -> « 699103570 »."""
    v = (valeur or '').strip()
    if not v:
        return ''
    morceaux = re.split(r'\s*(?:/|;|,|\bou\b|\bet\b|\n)\s*', v)
    for morceau in morceaux:
        d = re.sub(r'[^\d+]', '', morceau)
        if len(re.sub(r'\D', '', d)) >= 6:
            return d[:20]
    return re.sub(r'[^\d+]', '', v)[:20]


# Ordinaux et niveaux : « 2nde », « 2ème », « Seconde » -> « 2 »...
_ORDINAUX = {
    'premiere': '1', 'premier': '1', 'seconde': '2', 'second': '2', 'deuxieme': '2', 'troisieme': '3',
    'quatrieme': '4', 'cinquieme': '5', 'sixieme': '6', 'septieme': '7', 'terminale': 'tle', 'term': 'tle',
    'tle': 'tle', 'tles': 'tle', 'annee': '', 'an': '', 'eme': '', 'e': '', 'de': '', 'du': '', 'la': '', 'le': '',
    'classe': '', 'cycle': '', 'niveau': '', 'section': '', 'serie': '',
}


def jetons_classe(texte):
    jetons = []
    for mot in normaliser(texte).split():
        m = re.fullmatch(r'(\d+)(?:er|ere|e|eme|em|nd|nde|me|th|st|rd)?', mot)
        if m:
            jetons.append(str(int(m.group(1))))
            continue
        m = re.fullmatch(r'([a-z]+?)(\d+)', mot)  # « maco2 », « tle1 »
        if m:
            jetons.extend([_ORDINAUX.get(m.group(1), m.group(1)), m.group(2)])
            continue
        jetons.append(_ORDINAUX.get(mot, mot))
    return [j for j in jetons if j]


_MOTS_TITRE = re.compile(
    r"\b(listes?|provisoires?|definitives?|nominatives?|officielles?|generales?|actualisees?|"
    r"des|de|du|d|la|les|l|eleves?|etudiants?|apprenants?|inscrits?|classes?|effectifs?|"
    r"annee|scolaire|academique|annees|en|pour|au|aux|cetic|college|lycee|ces|cetif?)\b")


def libelle_classe_depuis_texte(texte):
    """« LISTE PROVISOIRES DES ELEVES  MACO 2 » -> « MACO 2 » ; « 6e A.xlsx » -> « 6E A »."""
    if not texte:
        return ''
    t = sans_accents(texte)
    t = re.sub(r'\.(docx?|xlsx?|csv|txt)$', '', t, flags=re.I)
    t = re.sub(r'\b(19|20)\d{2}\s*[-/_]\s*(19|20)?\d{2}\b', ' ', t)
    t = re.sub(r"[_]+", ' ', t)
    t = normaliser(t)
    t = _MOTS_TITRE.sub(' ', t)
    t = re.sub(r'\s+', ' ', t).strip()
    if not t or len(t) > 30:
        return ''
    return t.upper()


# ---------------------------------------------------------------------------
# Classes
# ---------------------------------------------------------------------------

def _libelles_classe(classe):
    cycle = classe.cycle.libelle if classe.cycle else ''
    option = classe.option or ''
    complet = f'{cycle} {option}'.strip()
    return complet, [complet, f'{option} {cycle}', option, cycle]


def rapprocher_classe(libelle, classes_app):
    """Classe de l'application la plus proche d'un libellé du fichier, ou None."""
    cible = jetons_classe(libelle)
    if not cible:
        return None
    meilleur, score_max, ex_aequo = None, 0.0, False
    for classe_id, (_, variantes) in classes_app.items():
        for variante in variantes:
            jetons = jetons_classe(variante)
            if not jetons:
                continue
            if Counter(jetons) == Counter(cible):
                score = 1.0
            else:
                communs = len(set(jetons) & set(cible))
                union = len(set(jetons) | set(cible))
                score = communs / union if union else 0
                # Les chiffres doivent concorder (« MACO 2 » ≠ « MACO 3 »).
                if {j for j in jetons if j.isdigit()} != {j for j in cible if j.isdigit()}:
                    score *= 0.5
                score = max(score, SequenceMatcher(None, ''.join(jetons), ''.join(cible)).ratio() * 0.9)
            if score > score_max + 1e-9:
                meilleur, score_max, ex_aequo = classe_id, score, False
            elif abs(score - score_max) < 1e-9 and classe_id != meilleur:
                ex_aequo = True
    if score_max >= 0.8 and not ex_aequo:
        return meilleur
    return None


def _cle_identite(nom, prenom):
    """Identité indépendante du découpage nom/prénom choisi lors d'un import
    précédent : « ABALA / MBOUNDA JOSEPH » == « ABALA MBOUNDA / JOSEPH »."""
    return ' '.join(sorted(normaliser(f'{nom} {prenom}').split()))


# ---------------------------------------------------------------------------
# Autres normalisations
# ---------------------------------------------------------------------------

EMAIL_RE = re.compile(r'[^@\s]+@[^@\s]+\.[a-z]{2,}')

_CIVILITE = re.compile(
    r'^(m\.|mr\.?|mme\.?|mlle\.?|mle\.?|monsieur|madame|mademoiselle|dr\.?|pr\.?|prof\.?|me\.?)\s+', re.I)
_CIVILITE_SEXE = {'m': 'M', 'mr': 'M', 'monsieur': 'M', 'mme': 'F', 'mlle': 'F', 'mle': 'F',
                  'madame': 'F', 'mademoiselle': 'F'}


def retirer_civilite(texte):
    """« Mme ABENG » -> (« ABENG », 'F') ; « Dr ETOA Paul » -> (« ETOA Paul », None)."""
    texte = nettoyer_espaces(texte)
    sexe = None
    while True:
        m = _CIVILITE.match(texte)
        if not m:
            return texte, sexe
        mot = m.group(1).lower().rstrip('.')
        sexe = sexe or _CIVILITE_SEXE.get(mot)
        texte = texte[m.end():].strip()


_JOURS = re.compile(r'\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|monday|tuesday|wednesday|thursday|friday)\b')
_HORAIRE = re.compile(r'^\d{1,2}\s*h\s*\d{0,2}')


def ressemble_emploi_du_temps(bloc):
    """Grille d'emploi du temps (jours en colonnes, créneaux horaires en
    lignes, colonnes « MATIERES / CLASSES » répétées) : ses cellules ne sont
    ni une liste de classes ni une liste de matières fiables."""
    entetes = [normaliser(e) for e in bloc['entetes']]
    if sum(1 for e in entetes if _JOURS.search(e)) >= 2:
        return True
    racines = Counter(re.sub(r'\s+\d+$', '', e) for e in entetes if e and not re.fullmatch(r'colonne \d+', e))
    if any(n >= 3 for n in racines.values()):
        return True
    for j in range(len(bloc['entetes'])):
        valeurs = [l[j] for l in bloc['lignes'] if j < len(l) and l[j]]
        if len(valeurs) >= 3 and sum(1 for v in valeurs if _HORAIRE.match(normaliser(v).replace(' ', ''))) >= 0.6 * len(valeurs):
            return True
    return False


def ressemble_a_une_classe(libelle):
    """Libellé tiré d'un titre ou d'un nom de fichier : on ne le retient comme
    classe que s'il en a l'allure (« 6E A », « MACO 2 », « TLE C »), pas
    « EMPLOI TEMPS PROFESSEUR »."""
    n = normaliser(libelle)
    if not n or len(n.split()) > 4:
        return False
    return bool(re.search(r'\d', n) or re.search(
        r'\b(tle|terminale|seconde|premiere|form|sixth|sil|cp|ce|cm|maternelle|petite|moyenne|grande)\b', n))


def email_valide(valeur):
    v = (valeur or '').strip().lower()
    return v if v and EMAIL_RE.fullmatch(v) else ''


def cle_libelle(texte):
    """Clé de comparaison d'un libellé (matière, groupe, cycle, grade...)."""
    return normaliser(texte)


def valider_blocs(payload, max_lignes=20000):
    """Contrôle du format des blocs renvoyés par le client. -> message ou None."""
    blocs = payload.get('blocs') if isinstance(payload, dict) else None
    if not isinstance(blocs, list) or not blocs:
        return "Aucune donnée à importer."
    for bloc in blocs:
        if not isinstance(bloc, dict) or not isinstance(bloc.get('entetes'), list) \
                or not isinstance(bloc.get('lignes'), list) \
                or not all(isinstance(l, list) for l in bloc['lignes']):
            return "Données d'import invalides."
    if sum(len(b['lignes']) for b in blocs) > max_lignes:
        return f"Trop de lignes en une fois ({max_lignes} maximum)."
    return None


def entier(valeur):
    """« 3 », « 3.0 », « 3,0 » -> 3 ; « 2,5 », « abc », '' -> None."""
    v = (str(valeur) if valeur is not None else '').strip().replace(',', '.')
    if not v:
        return None
    try:
        f = float(v)
    except ValueError:
        return None
    return int(f) if f.is_integer() else None


# ---------------------------------------------------------------------------
# Moteur générique de correspondance colonnes -> champs
# ---------------------------------------------------------------------------

def cle_colonne(entete, j):
    return normaliser(entete) or f'colonne {j + 1}'


def score_synonymes(synonymes, texte_norm):
    """Score 0..1 de ressemblance entre un intitulé normalisé et une liste de
    synonymes (même barème que pour les élèves)."""
    if not texte_norm:
        return 0.0
    meilleur = 0.0
    for syn in synonymes:
        if texte_norm == syn:
            return 1.0
        if len(syn) >= 3 and re.search(rf'(^| ){re.escape(syn)}( |$)', texte_norm):
            meilleur = max(meilleur, 0.6 + 0.35 * len(syn) / len(texte_norm))
        elif len(syn) >= 4:
            ratio = SequenceMatcher(None, texte_norm, syn).ratio()
            if ratio >= 0.82:
                meilleur = max(meilleur, ratio * 0.85)
    return meilleur


# Intitulés usuels de TOUS les tableaux scolaires : ils servent à repérer la
# ligne d'en-tête quel que soit le module qui lit le fichier (une liste
# d'élèves lue par l'import des classes doit garder son en-tête).
VOCABULAIRE_COMMUN = [
    'n', 'no', 'num', 'numero', 'n d ordre', 'noms et prenoms', 'nom et prenoms', 'nom et prenom', 'nom prenom',
    'nom', 'noms', 'prenom', 'prenoms', 'matricule', 'sexe', 'date de naissance', 'lieu de naissance', 'ne le',
    'ne e le', 'classe', 'classes', 'cycle', 'niveau', 'matiere', 'matieres', 'discipline', 'disciplines',
    'coefficient', 'coefficients', 'coef', 'coeff', 'enseignant', 'enseignants', 'professeur', 'telephone',
    'contact', 'email', 'e mail', 'grade', 'departement', 'groupe', 'effectif', 'observation', 'observations',
    'signature', 'statut', 'parent', 'tuteur', 'specialite',
]


class Schema:
    """Description des champs importables d'un module.

    champs     : [(clé, libellé, aide)] proposés à l'utilisateur
    synonymes  : {clé: [intitulés normalisés]} ; peut contenir des
                 pseudo-champs (« numero », « matricule »...) qui servent à
                 repérer la ligne d'en-tête sans être proposés
    exclure    : fn(champ, intitulé normalisé) -> True si le champ est exclu
                 pour cet intitulé (ex. « nom du parent » n'est pas « nom »)
    profil     : fn(valeurs) -> {champ: score} déduit du contenu d'une colonne
    combines   : [(champ combiné, (champs séparés...))] : si tous les champs
                 séparés sont présents, le champ combiné est retiré
    multiples  : champs pouvant occuper plusieurs colonnes d'un même tableau
                 (ex. coefficients d'une matière par classe, une colonne par classe)
    """

    def __init__(self, champs, synonymes, exclure=None, profil=None, combines=(), multiples=(), mot_cle_extra=None):
        # mot_cle_extra : fn(texte) -> bool, intitulés propres au module qui ne
        # sont pas des synonymes (ex. noms de classes en tête d'une grille).
        self.mot_cle_extra = mot_cle_extra
        self.champs = champs
        self.cles = {c[0] for c in champs}
        self.synonymes = synonymes
        self.exclure = exclure or (lambda champ, n: False)
        self.profil = profil or (lambda valeurs: {})
        self.combines = combines
        self.multiples = set(multiples)

    def score(self, champ, texte_norm):
        if self.exclure(champ, texte_norm):
            return 0.0
        return score_synonymes(self.synonymes.get(champ, ()), texte_norm)

    def est_mot_cle(self, texte):
        n = normaliser(texte)
        if not n or len(n) > 60:
            return False
        return any(self.score(champ, n) >= 0.6 for champ in self.synonymes) \
            or score_synonymes(VOCABULAIRE_COMMUN, n) >= 0.6 \
            or bool(self.mot_cle_extra and self.mot_cle_extra(texte))

    def colonnes(self, blocs):
        colonnes = {}
        for b_idx, bloc in enumerate(blocs):
            for j, entete in enumerate(bloc['entetes']):
                cle = cle_colonne(entete, j)
                col = colonnes.setdefault(cle, {'cle': cle, 'libelle': entete, 'blocs': set(), 'valeurs': []})
                col['blocs'].add(b_idx)
                if len(col['valeurs']) < 300:
                    col['valeurs'].extend(l[j] for l in bloc['lignes'][:100] if j < len(l))
        return colonnes

    def suggerer(self, blocs, scores_supplementaires=None):
        """-> (mapping {clé colonne: champ}, liste des colonnes pour l'interface).

        scores_supplementaires : fn(clé colonne, colonne) -> {champ: score},
        pour des règles propres au module (ex. intitulé = nom d'une classe)."""
        colonnes = self.colonnes(blocs)
        candidats = []
        for cle, col in colonnes.items():
            generique = re.fullmatch(r'colonne \d+', cle) is not None
            contenu = self.profil(col['valeurs'])
            extra = scores_supplementaires(cle, col) if scores_supplementaires else {}
            for champ in set(self.cles) | set(self.synonymes) | set(extra):
                s_titre = 0.0 if generique else self.score(champ, cle)
                s_contenu = contenu.get(champ, 0.0)
                score = s_titre if s_titre >= 0.6 else max(
                    s_titre, s_contenu * (1.0 if generique or not s_titre else 0.9))
                score = max(score, extra.get(champ, 0.0))
                if score > 0:
                    candidats.append((score, champ, cle))
        candidats.sort(key=lambda c: -c[0])

        mapping, confiance = {}, {}
        blocs_par_champ = defaultdict(set)
        for score, champ, cle in candidats:
            if score < 0.5 or cle in mapping:
                continue
            if champ not in self.multiples and blocs_par_champ[champ] & colonnes[cle]['blocs']:
                continue
            mapping[cle] = champ
            confiance[cle] = round(score, 2)
            blocs_par_champ[champ] |= colonnes[cle]['blocs']

        for combine, separes in self.combines:
            champs = set(mapping.values())
            if combine in champs and all(s in champs for s in separes):
                for cle in [c for c, ch in mapping.items() if ch == combine]:
                    del mapping[cle]
        # Pseudo-champs (« numero »...) : servent à la détection, jamais importés.
        mapping = {cle: champ for cle, champ in mapping.items() if champ in self.cles}

        liste = []
        for cle, col in colonnes.items():
            exemples = []
            for v in col['valeurs']:
                if v and v not in exemples:
                    exemples.append(v)
                if len(exemples) == 3:
                    break
            liste.append({
                'cle': cle, 'libelle': col['libelle'], 'nb_tableaux': len(col['blocs']),
                'exemples': exemples, 'champ': mapping.get(cle, ''), 'confiance': confiance.get(cle, 0),
            })
        return mapping, liste

    def lignes(self, blocs, mapping, corrections=None, champs_corrigeables=()):
        """Parcourt les lignes des blocs ; pour chacune :
        (id, source, valeurs {champ: texte}, multiples {champ: [(intitulé, texte)]}, bloc).
        Les corrections saisies dans l'aperçu remplacent les valeurs du fichier."""
        corrections = corrections or {}
        autorises = self.cles | set(champs_corrigeables)
        for b_idx, bloc in enumerate(blocs):
            index = defaultdict(list)
            for j, entete in enumerate(bloc['entetes']):
                champ = mapping.get(cle_colonne(entete, j))
                if champ in self.cles:
                    index[champ].append(j)
            numeros = bloc.get('numeros') or []
            for l_idx, ligne in enumerate(bloc['lignes']):
                valeurs, multiples = {}, {}
                for champ, cols in index.items():
                    if champ in self.multiples:
                        multiples[champ] = [(bloc['entetes'][j], nettoyer_espaces(str(ligne[j])))
                                            for j in cols if j < len(ligne) and str(ligne[j]).strip()]
                    else:
                        valeurs[champ] = next((nettoyer_espaces(str(ligne[j])) for j in cols
                                               if j < len(ligne) and str(ligne[j]).strip()), '')
                rid = f'{b_idx}:{l_idx}'
                for champ, v in (corrections.get(rid) or {}).items():
                    if champ in autorises:
                        valeurs[champ] = nettoyer_espaces(str(v)) if v is not None else ''
                numero = numeros[l_idx] if l_idx < len(numeros) else l_idx + 1
                yield rid, f"{bloc.get('source') or 'Fichier'} · ligne {numero}", valeurs, multiples, bloc

    def description_champs(self):
        return [{'cle': c[0], 'libelle': c[1], 'aide': c[2]} for c in self.champs]


def analyser_avec_schema(fichiers, texte_colle, schema, fiches=False, pertinence=None, preparer=None):
    """Lecture des fichiers pour un module donné. -> (blocs, erreurs).

    preparer : fn(bloc) appelée sur chaque bloc avant le calcul de sa
    pertinence (ex. fusion de l'en-tête de groupe « LUNDI » dans les
    intitulés de colonnes d'une grille d'emploi du temps)."""
    from services.import_lecture import ErreurLecture, construire_blocs, lire_fichier, lire_texte_tabule
    blocs, erreurs = [], []
    for nom, contenu in fichiers:
        try:
            trouves = lire_fichier(nom, contenu, schema.est_mot_cle, fiches=fiches)
        except ErreurLecture as exc:
            erreurs.append({'fichier': nom, 'message': str(exc)})
            continue
        except Exception:
            erreurs.append({'fichier': nom, 'message': "Fichier illisible ou endommagé."})
            continue
        if not trouves:
            erreurs.append({'fichier': nom, 'message': "Aucun tableau de données trouvé dans ce fichier."})
        blocs.extend(trouves)
    if texte_colle and texte_colle.strip():
        trouves = construire_blocs('Tableau collé', 'Tableau collé',
                                   [('Tableau collé', [], lire_texte_tabule(texte_colle))], schema.est_mot_cle)
        if not trouves:
            erreurs.append({'fichier': 'Tableau collé', 'message': "Aucune donnée reconnue dans le texte collé."})
        blocs.extend(trouves)
    for bloc in blocs:
        if preparer:
            preparer(bloc)
        bloc.pop('entetes_groupe', None)
        bloc['classe_detectee'] = libelle_classe_depuis_texte(bloc.get('contexte')) \
            or libelle_classe_depuis_texte(bloc.get('fichier_base'))
        bloc['pertinent'] = pertinence(bloc) if pertinence else True
    return blocs, erreurs
