"""Import de masse des élèves depuis les archives des établissements.

Chaîne de traitement (identique en aperçu et en import réel, pour que
l'aperçu montre EXACTEMENT ce qui sera enregistré) :

  1. analyser_fichiers   : fichiers -> blocs (import_lecture.py)
  2. suggerer_correspondance : colonnes du fichier -> champs de l'application
     (synonymes des intitulés + analyse du contenu des cellules)
  3. traiter             : extraction, nettoyage, découpage nom/prénom, dates,
     sexe, classes, parents, doublons ; puis, si valider=True, écriture en
     une seule transaction.

Aucune dépendance payante : difflib (standard) pour les rapprochements
approximatifs.
"""

import re
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime
from difflib import SequenceMatcher

from extensions import db
from models.inscription_models import Eleve, Inscription, Parent
from models.structure_models import AnneeScolaire, Classe
from services.import_commun import (
    _cle_identite, _libelles_classe, casse_prenom, chiffres_telephone,
    libelle_classe_depuis_texte, nettoyer_espaces, normaliser_matricule, parser_date, parser_sexe,
    premier_telephone, rapprocher_classe, separer_date_lieu, separer_nom_complet,
)
from services.import_lecture import ErreurLecture, lire_fichier, normaliser

# ---------------------------------------------------------------------------
# Champs de l'application et synonymes des intitulés de colonnes
# ---------------------------------------------------------------------------

# (clé, libellé affiché, aide)
CHAMPS = [
    ('nom_complet', 'Nom et prénom(s) dans une même colonne', 'Découpé automatiquement en nom + prénom'),
    ('nom', 'Nom', ''),
    ('prenom', 'Prénom(s)', ''),
    ('matricule', 'Matricule', 'Généré automatiquement s\'il manque (option)'),
    ('sexe', 'Sexe', 'M/F, Masculin/Féminin, Garçon/Fille…'),
    ('date_naissance', 'Date de naissance', '12/03/2010, 2010-03-12, 12 mars 2010…'),
    ('lieu_naissance', 'Lieu de naissance', ''),
    ('date_lieu_naissance', 'Date et lieu de naissance (même colonne)', '« 12/03/2010 à Bafia »'),
    ('classe', 'Classe', 'Sinon déduite du titre du tableau ou du nom du fichier'),
    ('statut', 'Statut (actif / inactif)', ''),
    ('parent_nom_complet', 'Parent : nom et prénom', ''),
    ('parent_nom', 'Parent : nom', ''),
    ('parent_prenom', 'Parent : prénom', ''),
    ('parent_telephone', 'Parent : téléphone', ''),
    ('parent_email', 'Parent : e-mail', ''),
]
CLES_CHAMPS = {c[0] for c in CHAMPS}

SYNONYMES = {
    'numero': ['n', 'no', 'nº', 'num', 'numero', 'n d ordre', 'no d ordre', 'numero d ordre', 'ordre', 'rang', 'n o', 'nr'],
    'nom_complet': ['noms et prenoms', 'nom et prenoms', 'nom et prenom', 'noms et prenom', 'nom prenom', 'nom prenoms',
                    'noms prenoms', 'nom s et prenom s', 'nom complet', 'noms', 'eleve', 'eleves', 'nom de l eleve',
                    'noms de l eleve', 'nom et prenoms de l eleve', 'noms et prenoms de l eleve', 'identite',
                    'nom et prenom de l eleve', 'nom et prenom s', 'noms et prenoms des eleves', 'full name', 'name'],
    'nom': ['nom', 'nom de famille', 'nom eleve', 'surname', 'last name', 'family name'],
    'prenom': ['prenom', 'prenoms', 'prenom s', 'prenom eleve', 'prenoms eleve', 'first name', 'given name'],
    'matricule': ['matricule', 'matricules', 'mat', 'matr', 'mle', 'n mle', 'n matricule', 'no matricule', 'numero matricule',
                  'numero de matricule', 'matricule eleve', 'identifiant', 'id', 'code eleve', 'code', 'id eleve', 'ine'],
    'sexe': ['sexe', 'sex', 's', 'genre', 'gender', 'm f', 'g f', 'sexe m f', 'sexe g f'],
    'date_naissance': ['date de naissance', 'date naissance', 'date de nais', 'date nais', 'ne le', 'nee le', 'ne e le',
                       'dn', 'ddn', 'naissance', 'date of birth', 'dob', 'birth date', 'date naiss', 'ne e le'],
    'lieu_naissance': ['lieu de naissance', 'lieu naissance', 'lieu de nais', 'lieu nais', 'ne a', 'nee a', 'ne e a',
                       'lieu', 'ln', 'place of birth', 'lieu naiss'],
    'date_lieu_naissance': ['date et lieu de naissance', 'date lieu de naissance', 'date et lieu naissance',
                            'ne le et a', 'ne e le et a', 'ne e le a', 'ne le a', 'naissance date et lieu',
                            'date et lieu de nais', 'date lieu naissance'],
    'classe': ['classe', 'classes', 'niveau', 'salle', 'section', 'division', 'cl', 'classe actuelle', 'classe frequentee',
               'serie', 'filiere', 'specialite', 'promotion'],
    'statut': ['statut', 'etat', 'statut eleve', 'actif', 'status'],
    'parent_nom_complet': ['parent', 'parents', 'nom du parent', 'noms du parent', 'nom et prenom du parent',
                           'noms et prenoms du parent', 'tuteur', 'nom du tuteur', 'parent tuteur', 'parent ou tuteur',
                           'nom du pere', 'nom de la mere', 'pere', 'mere', 'responsable', 'nom du responsable',
                           'nom parent', 'noms des parents', 'parent d eleve', 'tuteur legal'],
    'parent_nom': ['nom de famille du parent', 'nom parent famille'],
    'parent_prenom': ['prenom du parent', 'prenoms du parent', 'prenom parent', 'prenom du tuteur'],
    'parent_telephone': ['telephone', 'tel', 'tel parent', 'telephone parent', 'telephone du parent', 'contact', 'contacts',
                         'contact parent', 'contact du parent', 'contacts parents', 'numero de telephone', 'n telephone',
                         'portable', 'cel', 'cell', 'cellulaire', 'phone', 'mobile', 'telephone tuteur', 'tel tuteur',
                         'contact tuteur', 'whatsapp', 'tel du parent'],
    'parent_email': ['email', 'e mail', 'mail', 'courriel', 'adresse email', 'adresse e mail', 'email parent',
                     'e mail parent', 'email du parent', 'adresse mail'],
}
_MOTS_PARENT = re.compile(r'\b(parents?|pere|mere|tuteurs?|tutrice|responsable)\b')

LIMITES = {'matricule': 50, 'nom': 100, 'prenom': 150, 'lieu_naissance': 100}

LIEU_DEFAUT = 'Non renseigné'
EMAIL_PROVISOIRE = 'a-completer.invalid'


# ---------------------------------------------------------------------------
# Reconnaissance des intitulés
# ---------------------------------------------------------------------------

def score_intitule(champ, texte_norm):
    """Score 0..1 de ressemblance entre un intitulé normalisé et un champ."""
    if not texte_norm:
        return 0.0
    parent = bool(_MOTS_PARENT.search(texte_norm))
    if champ.startswith('parent_') and champ not in ('parent_telephone', 'parent_email') and not parent:
        # « Nom » seul ne désigne pas le parent.
        if texte_norm not in SYNONYMES[champ]:
            return 0.0
    if parent and not champ.startswith('parent_') and champ != 'numero':
        return 0.0
    meilleur = 0.0
    for syn in SYNONYMES[champ]:
        if texte_norm == syn:
            return 1.0
        if len(syn) >= 3 and re.search(rf'(^| ){re.escape(syn)}( |$)', texte_norm):
            # « date de naissance de l eleve » contient « date de naissance ».
            meilleur = max(meilleur, 0.6 + 0.35 * len(syn) / len(texte_norm))
        elif len(syn) >= 4:
            ratio = SequenceMatcher(None, texte_norm, syn).ratio()
            if ratio >= 0.82:
                meilleur = max(meilleur, ratio * 0.85)
    return meilleur


def est_intitule_connu(texte):
    n = normaliser(texte)
    if not n or len(n) > 60:
        return False
    return any(score_intitule(champ, n) >= 0.6 for champ in SYNONYMES)


def parser_statut(valeur):
    n = normaliser(valeur)
    if not n:
        return None
    if re.search(r'\b(inactif|inactive|parti|partie|exclu|exclue|abandon|radie|radiee|demission|transfere|decede|non)\b', n):
        return 'Inactif'
    return 'Actif'


# ---------------------------------------------------------------------------
# Correspondance colonnes -> champs
# ---------------------------------------------------------------------------

def _profil_contenu(valeurs):
    """Scores 0..1 déduits des VALEURS d'une colonne (utile quand l'intitulé
    est absent ou inconnu)."""
    vals = [v for v in valeurs if v][:200]
    if not vals:
        return {}
    total = len(vals)
    frac = lambda pred: sum(1 for v in vals if pred(v)) / total  # noqa: E731
    scores = {}
    f_sexe = frac(lambda v: parser_sexe(v) in ('M', 'F') and len(v) <= 9)
    if f_sexe >= 0.8:
        scores['sexe'] = 0.9
    f_date = frac(lambda v: parser_date(v)[0] is not None)
    if f_date >= 0.7:
        f_texte = frac(lambda v: bool(separer_date_lieu(v)[1]))
        if f_texte >= 0.5:
            scores['date_lieu_naissance'] = 0.85
        else:
            scores['date_naissance'] = 0.85
    if frac(lambda v: re.fullmatch(r'[^@\s]+@[^@\s]+\.[a-z]{2,}', v.lower()) is not None) >= 0.6:
        scores['parent_email'] = 0.9
    entiers = [v for v in vals if re.fullmatch(r'\d{1,4}\.?', v)]
    if len(entiers) == total and total >= 3:
        nums = [int(v.rstrip('.')) for v in entiers]
        if sum(1 for a, b in zip(nums, nums[1:]) if b == a + 1) >= 0.7 * (total - 1):
            scores['numero'] = 0.95
    f_alnum = frac(lambda v: re.fullmatch(r'[A-Za-z0-9/\-]{5,20}', v) is not None and re.search(r'\d{3}', v) is not None)
    if f_alnum >= 0.8 and len(set(vals)) >= 0.95 * total:
        scores['matricule'] = 0.55
    f_mots = frac(lambda v: len(v.split()) >= 2 and re.search(r'\d', v) is None)
    if f_mots >= 0.8:
        scores['nom_complet'] = 0.5
    return scores


def _colonnes(blocs):
    """Union des colonnes de tous les blocs, identifiées par leur intitulé
    normalisé (deux fichiers avec « NOMS ET PRENOMS » partagent la colonne)."""
    colonnes = {}
    for b_idx, bloc in enumerate(blocs):
        for j, entete in enumerate(bloc['entetes']):
            cle = normaliser(entete) or f'colonne {j + 1}'
            col = colonnes.setdefault(cle, {'cle': cle, 'libelle': entete, 'blocs': set(), 'valeurs': []})
            col['blocs'].add(b_idx)
            if len(col['valeurs']) < 300:
                col['valeurs'].extend(l[j] for l in bloc['lignes'][:100] if j < len(l))
    return colonnes


def suggerer_correspondance(blocs):
    colonnes = _colonnes(blocs)
    candidats = []
    for cle, col in colonnes.items():
        generique = re.fullmatch(r'colonne \d+', cle) is not None
        contenu = _profil_contenu(col['valeurs'])
        for champ in list(CLES_CHAMPS) + ['numero']:
            s_titre = 0.0 if generique else score_intitule(champ, cle)
            s_contenu = contenu.get(champ, 0.0)
            score = s_titre if s_titre >= 0.6 else max(s_titre, s_contenu * (1.0 if generique or not s_titre else 0.9))
            # Un intitulé reconnu pour un AUTRE champ l'emporte sur le contenu.
            if score > 0:
                candidats.append((score, champ, cle))
    candidats.sort(key=lambda c: -c[0])

    mapping, confiance = {}, {}
    blocs_par_champ = defaultdict(set)
    for score, champ, cle in candidats:
        if score < 0.5 or cle in mapping:
            continue
        # Un même champ peut venir de colonnes différentes selon le fichier,
        # tant qu'elles ne cohabitent jamais dans un même tableau.
        if blocs_par_champ[champ] & colonnes[cle]['blocs']:
            continue
        mapping[cle] = champ
        confiance[cle] = round(score, 2)
        blocs_par_champ[champ] |= colonnes[cle]['blocs']

    # Cohérences : colonnes séparées prioritaires sur les colonnes combinées.
    champs = set(mapping.values())
    if 'nom' in champs and 'prenom' not in champs and 'nom_complet' not in champs:
        # « NOM » seul contenant en fait « NOM Prénoms ».
        for cle, champ in mapping.items():
            if champ == 'nom' and _profil_contenu(colonnes[cle]['valeurs']).get('nom_complet'):
                mapping[cle] = 'nom_complet'
    for combine, separes in (('nom_complet', ('nom', 'prenom')),
                             ('date_lieu_naissance', ('date_naissance', 'lieu_naissance')),
                             ('parent_nom_complet', ('parent_nom', 'parent_prenom'))):
        champs = set(mapping.values())
        if combine in champs and all(s in champs for s in separes):
            for cle in [c for c, ch in mapping.items() if ch == combine]:
                del mapping[cle]
    mapping = {cle: champ for cle, champ in mapping.items() if champ != 'numero'}

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


# ---------------------------------------------------------------------------
# Lecture des fichiers
# ---------------------------------------------------------------------------

def analyser_fichiers(fichiers, texte_colle=None):
    """fichiers : liste de (nom, contenu bytes). -> (blocs, erreurs)."""
    blocs, erreurs = [], []
    for nom, contenu in fichiers:
        try:
            trouves = lire_fichier(nom, contenu, est_intitule_connu)
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
        from services.import_lecture import construire_blocs, lire_texte_tabule
        trouves = construire_blocs('Tableau collé', 'Tableau collé',
                                   [('Tableau collé', [], lire_texte_tabule(texte_colle))], est_intitule_connu)
        if not trouves:
            erreurs.append({'fichier': 'Tableau collé', 'message': "Aucune donnée reconnue dans le texte collé."})
        blocs.extend(trouves)
    for bloc in blocs:
        bloc.pop('entetes_groupe', None)
        bloc['classe_detectee'] = libelle_classe_depuis_texte(bloc.get('contexte')) \
            or libelle_classe_depuis_texte(bloc.get('fichier_base'))
        bloc['pertinent'] = est_liste_eleves(bloc)
    return blocs, erreurs


_CHAMPS_IDENTITE = ('nom_complet', 'nom', 'prenom', 'matricule', 'sexe', 'date_naissance', 'date_lieu_naissance')


def est_liste_eleves(bloc):
    """Un tableau d'emploi du temps ou de notes ne doit pas être importé
    comme liste d'élèves : il faut au moins deux colonnes d'identité
    reconnues (par leur intitulé ou, à défaut, par leur contenu)."""
    trouves = set()
    for j, entete in enumerate(bloc['entetes']):
        n = normaliser(entete)
        for champ in _CHAMPS_IDENTITE:
            if n and not re.fullmatch(r'colonne \d+', n) and score_intitule(champ, n) >= 0.6:
                trouves.add(champ)
        if re.fullmatch(r'colonne \d+', n or 'colonne 0'):
            contenu = _profil_contenu([l[j] for l in bloc['lignes'][:100] if j < len(l)])
            trouves |= {c for c in contenu if c in _CHAMPS_IDENTITE and contenu[c] >= 0.8}
    if 'nom_complet' in trouves or ('nom' in trouves and 'prenom' in trouves):
        return len(trouves) >= 2
    return len(trouves) >= 3


# ---------------------------------------------------------------------------
# Traitement (aperçu ou import)
# ---------------------------------------------------------------------------

def _options(brutes):
    o = dict(brutes or {})
    return {
        'separation': o.get('separation') if o.get('separation') in ('premier', 'deux', 'dernier') else 'premier',
        'harmoniser_casse': bool(o.get('harmoniser_casse', True)),
        'doublons': 'mettre_a_jour' if o.get('doublons') == 'mettre_a_jour' else 'ignorer',
        'matricules_auto': bool(o.get('matricules_auto', True)),
        'prefixe_matricule': nettoyer_espaces(str(o.get('prefixe_matricule') or ''))[:20],
        'lieu_defaut': nettoyer_espaces(str(o.get('lieu_defaut') if o.get('lieu_defaut') is not None else LIEU_DEFAUT))[:100],
        'sexe_defaut': o.get('sexe_defaut') if o.get('sexe_defaut') in ('M', 'F') else None,
        'statut_defaut': 'Inactif' if o.get('statut_defaut') == 'Inactif' else 'Actif',
        'parent_defaut': o.get('parent_defaut') or 'provisoire',
        'inscrire': bool(o.get('inscrire', True)),
        'annee_scolaire_id': o.get('annee_scolaire_id'),
        'date_inscription': o.get('date_inscription'),
        'classes': {str(k): v for k, v in (o.get('classes') or {}).items()},
        'classe_fixe': o.get('classe_fixe'),
        'classe_depuis_titre': bool(o.get('classe_depuis_titre', True)),
    }


def traiter(etablissement_id, payload, valider=False):
    blocs = payload.get('blocs') or []
    if not isinstance(blocs, list) or not blocs:
        return {'erreur': "Aucune donnée à importer."}, 400
    for bloc in blocs:
        if not isinstance(bloc, dict) or not isinstance(bloc.get('entetes'), list) or not isinstance(bloc.get('lignes'), list):
            return {'erreur': "Données d'import invalides."}, 400
    if sum(len(b['lignes']) for b in blocs) > 20000:
        return {'erreur': "Trop de lignes en une fois (20 000 maximum)."}, 400

    options = _options(payload.get('options'))
    corrections = payload.get('corrections') or {}
    exclues = set(payload.get('exclues') or [])

    mapping_suggere, colonnes = suggerer_correspondance(blocs)
    mapping = payload.get('mapping')
    if not isinstance(mapping, dict):
        mapping = mapping_suggere
    mapping = {cle: champ for cle, champ in mapping.items() if champ in CLES_CHAMPS}
    for col in colonnes:
        col['champ'] = mapping.get(col['cle'], '')

    # --- Référentiels de l'établissement -----------------------------------
    classes = Classe.query.filter_by(etablissement_id=etablissement_id).all()
    classes_app = {c.id: _libelles_classe(c) for c in classes}
    annees = AnneeScolaire.query.filter_by(etablissement_id=etablissement_id).all()
    annee_id = options['annee_scolaire_id']
    try:
        annee_id = int(annee_id) if annee_id not in (None, '') else None
    except (TypeError, ValueError):
        annee_id = None
    if annee_id is None:
        active = next((a for a in annees if a.active), None) or max(annees, key=lambda a: a.libelle, default=None)
        annee_id = active.id if active else None
    elif annee_id not in {a.id for a in annees}:
        return {'erreur': "Année scolaire invalide pour cet établissement."}, 400

    eleves = Eleve.query.filter_by(etablissement_id=etablissement_id).all()
    par_matricule = {normaliser_matricule(e.matricule): e for e in eleves}
    par_identite = defaultdict(list)
    for e in eleves:
        par_identite[_cle_identite(e.nom, e.prenom)].append(e)

    parents = Parent.query.filter_by(etablissement_id=etablissement_id).all()
    parent_par_tel = {chiffres_telephone(p.telephone): p for p in parents if len(chiffres_telephone(p.telephone)) >= 6}
    parent_par_email = {p.email.lower(): p for p in parents if p.email}

    inscriptions_annee = {}
    if annee_id:
        q = (Inscription.query.join(Classe, Inscription.classe_id == Classe.id)
             .filter(Classe.etablissement_id == etablissement_id, Inscription.annee_scolaire_id == annee_id))
        for i in q.all():
            inscriptions_annee.setdefault(i.eleve_id, i)

    def resoudre_classe_id(valeur):
        try:
            v = int(valeur)
        except (TypeError, ValueError):
            return None
        return v if v in classes_app else None

    # --- Classes détectées dans les fichiers -------------------------------
    detectees = Counter()
    lignes_ctx = []
    for b_idx, bloc in enumerate(blocs):
        index = defaultdict(list)
        for j, entete in enumerate(bloc['entetes']):
            champ = mapping.get(normaliser(entete) or f'colonne {j + 1}')
            if champ:
                index[champ].append(j)
        titre_classe = (bloc.get('classe_detectee') or '') if options['classe_depuis_titre'] else ''
        numeros = bloc.get('numeros') or []
        for l_idx, ligne in enumerate(bloc['lignes']):
            valeurs = {}
            for champ, cols in index.items():
                valeurs[champ] = next((nettoyer_espaces(str(ligne[j])) for j in cols if j < len(ligne) and str(ligne[j]).strip()), '')
            rid = f'{b_idx}:{l_idx}'
            for champ, v in (corrections.get(rid) or {}).items():
                if champ in CLES_CHAMPS or champ == 'classe_id':
                    valeurs[champ] = nettoyer_espaces(str(v)) if v is not None else ''
            libelle = valeurs.get('classe') or titre_classe
            if libelle and not valeurs.get('classe_id'):
                detectees[libelle] += 1
            numero = numeros[l_idx] if l_idx < len(numeros) else l_idx + 1
            lignes_ctx.append((rid, f"{bloc.get('source') or 'Fichier'} · ligne {numero}", valeurs, libelle))

    correspondance_classes = {}
    classes_detectees = []
    for libelle, nb in sorted(detectees.items()):
        if libelle in options['classes']:
            choix = resoudre_classe_id(options['classes'][libelle])
            suggere = False
        else:
            choix = rapprocher_classe(libelle, classes_app)
            suggere = choix is not None
        correspondance_classes[libelle] = choix
        classes_detectees.append({'libelle': libelle, 'nb': nb, 'classe_id': choix, 'suggere': suggere})
    classe_fixe = resoudre_classe_id(options['classe_fixe'])

    # --- Ligne par ligne ---------------------------------------------------
    resultats = []
    vus_matricule, vus_identite = {}, {}
    sans_matricule = []
    for rid, source, v, libelle in lignes_ctx:
        r = {'id': rid, 'source': source, 'erreurs': [], 'avertissements': [], 'statut': 'nouveau',
             'eleve_id': None, 'changements': [], 'matricule_genere': False}
        if rid in exclues:
            r['statut'] = 'exclu'

        # Nom / prénom
        nom, prenom = v.get('nom', ''), v.get('prenom', '')
        if v.get('nom_complet') and not (nom and prenom):
            n2, p2 = separer_nom_complet(v['nom_complet'], options['separation'])
            nom = nom or n2
            prenom = prenom or p2
        nom, prenom = nettoyer_espaces(nom), nettoyer_espaces(prenom)
        if options['harmoniser_casse']:
            nom, prenom = nom.upper(), casse_prenom(prenom)

        # Date / lieu
        brut_date, lieu = v.get('date_naissance', ''), v.get('lieu_naissance', '')
        if v.get('date_lieu_naissance'):
            d2, l2 = separer_date_lieu(v['date_lieu_naissance'])
            brut_date = brut_date or d2
            lieu = lieu or l2
        date_naissance, alerte = parser_date(brut_date)
        if alerte:
            r['avertissements'].append(alerte)
        if date_naissance:
            age = (date.today() - date_naissance).days / 365.25
            if age < 2 or age > 45:
                r['avertissements'].append(f"Date de naissance improbable ({date_naissance.strftime('%d/%m/%Y')})")
        lieu = nettoyer_espaces(lieu)
        if options['harmoniser_casse'] and lieu:
            lieu = lieu.upper()
        lieu_vide = not lieu

        sexe = parser_sexe(v.get('sexe', ''))
        sexe_invalide = sexe is False
        if sexe is False:
            sexe = None
        statut = parser_statut(v.get('statut', '')) or options['statut_defaut']
        matricule = normaliser_matricule(v.get('matricule', ''))

        # Parent (s'il figure dans le fichier)
        p_nom, p_prenom = v.get('parent_nom', ''), v.get('parent_prenom', '')
        if v.get('parent_nom_complet') and not (p_nom and p_prenom):
            texte = re.sub(r'(?i)^(m\.|mr|mme|mlle|monsieur|madame|mademoiselle|dr|pere|mere)\.?\s+', '', v['parent_nom_complet'])
            n2, p2 = separer_nom_complet(texte, 'premier')
            p_nom, p_prenom = p_nom or n2, p_prenom or p2
        p_tel = premier_telephone(v.get('parent_telephone', ''))
        p_email = (v.get('parent_email', '') or '').strip().lower()
        if p_email and not re.fullmatch(r'[^@\s]+@[^@\s]+\.[a-z]{2,}', p_email):
            r['avertissements'].append(f"E-mail du parent invalide « {p_email} », ignoré")
            p_email = ''
        parent = None
        if p_nom or p_prenom or p_tel or p_email:
            parent = {'nom': nettoyer_espaces(p_nom).upper()[:100], 'prenom': casse_prenom(nettoyer_espaces(p_prenom))[:100],
                      'telephone': p_tel, 'email': p_email}

        # Classe
        classe_id = resoudre_classe_id(v.get('classe_id')) if v.get('classe_id') else None
        if classe_id is None and libelle:
            classe_id = correspondance_classes.get(libelle)
        if classe_id is None:
            classe_id = classe_fixe

        # Élève déjà enregistré ?
        existant = None
        if matricule:
            existant = par_matricule.get(matricule)
        if existant is None and nom and prenom:
            homonymes = par_identite.get(_cle_identite(nom, prenom), [])
            if not matricule:
                memes = [e for e in homonymes if date_naissance and e.date_naissance == date_naissance] or \
                        (homonymes if len(homonymes) == 1 and not date_naissance else [])
                if len(memes) == 1:
                    existant = memes[0]
                    r['avertissements'].append("Reconnu par son nom et sa date de naissance (pas de matricule dans le fichier)")
            elif any(e.date_naissance == date_naissance for e in homonymes if date_naissance):
                r['avertissements'].append("Un élève de même nom et même date de naissance existe déjà avec un autre matricule")

        # Doublons à l'intérieur des fichiers importés
        cle_id = (_cle_identite(nom, prenom), date_naissance)
        if r['statut'] != 'exclu':
            if matricule and matricule in vus_matricule:
                r['erreurs'].append(f"Matricule {matricule} déjà présent ({vus_matricule[matricule]})")
            elif not matricule and nom and prenom and cle_id in vus_identite and existant is None:
                r['erreurs'].append(f"Élève en double ({vus_identite[cle_id]})")
            if matricule:
                vus_matricule.setdefault(matricule, source)
            if nom and prenom:
                vus_identite.setdefault(cle_id, source)

        donnees = {
            'matricule': matricule, 'nom': nom, 'prenom': prenom, 'sexe': sexe,
            'date_naissance': date_naissance.isoformat() if date_naissance else None,
            'lieu_naissance': lieu, 'statut': statut, 'classe_libelle': libelle or '',
            'classe_id': classe_id, 'parent': parent,
        }

        if existant is not None:
            r['eleve_id'] = existant.id
            r['statut'] = 'exclu' if r['statut'] == 'exclu' else 'existant'
            donnees['matricule'] = existant.matricule
            if options['doublons'] == 'mettre_a_jour':
                for champ in ('nom', 'prenom', 'sexe', 'lieu_naissance', 'statut'):
                    if donnees[champ] and donnees[champ] != getattr(existant, champ) and not (champ == 'lieu_naissance' and lieu_vide):
                        r['changements'].append(champ)
                if date_naissance and date_naissance != existant.date_naissance:
                    r['changements'].append('date_naissance')
                for champ in ('nom', 'prenom', 'lieu_naissance'):
                    if champ in r['changements'] and len(donnees[champ]) > LIMITES[champ]:
                        r['changements'].remove(champ)
                if r['changements'] and r['statut'] != 'exclu':
                    r['statut'] = 'maj'
            if r['erreurs'] and r['statut'] != 'exclu':
                r['statut'] = 'erreur'
        else:
            # Nouvel élève : tous les champs obligatoires doivent être là.
            if not nom:
                r['erreurs'].append("Nom manquant")
            if not prenom:
                r['erreurs'].append("Prénom manquant" + (" (une seule partie dans le nom complet)" if nom else ""))
            if sexe_invalide:
                r['erreurs'].append(f"Sexe non reconnu « {v.get('sexe')} »")
            elif not sexe:
                if options['sexe_defaut']:
                    donnees['sexe'] = options['sexe_defaut']
                    r['avertissements'].append("Sexe absent : valeur par défaut appliquée")
                else:
                    r['erreurs'].append("Sexe manquant")
            if lieu_vide:
                if options['lieu_defaut']:
                    donnees['lieu_naissance'] = options['lieu_defaut']
                else:
                    r['erreurs'].append("Lieu de naissance manquant")
            for champ, maxi in LIMITES.items():
                if len(donnees[champ] or '') > maxi:
                    r['erreurs'].append(f"{champ.replace('_', ' ').capitalize()} trop long ({maxi} caractères maximum)")
            if not matricule:
                if options['matricules_auto']:
                    sans_matricule.append(r)
                else:
                    r['erreurs'].append("Matricule manquant")
            if r['statut'] == 'exclu':
                pass
            elif r['erreurs']:
                r['statut'] = 'erreur'

        # Inscription pour l'année choisie
        if not options['inscrire'] or not annee_id:
            r['inscription'] = 'non'
        elif classe_id is None:
            r['inscription'] = 'sans_classe'
            if r['statut'] not in ('erreur', 'exclu') and options['inscrire']:
                r['avertissements'].append(
                    f"Classe « {libelle} » non associée : pas d'inscription" if libelle else "Aucune classe : pas d'inscription")
        elif existant is not None and existant.id in inscriptions_annee:
            deja = inscriptions_annee[existant.id]
            r['inscription'] = 'deja' if deja.classe_id == classe_id else 'autre_classe'
            if deja.classe_id != classe_id:
                r['avertissements'].append(f"Déjà inscrit cette année en {classes_app.get(deja.classe_id, ('?',))[0]} : inscription inchangée")
        else:
            r['inscription'] = 'nouvelle'

        r['donnees'] = donnees
        resultats.append(r)

    # --- Matricules générés -------------------------------------------------
    if sans_matricule:
        prefixe = options['prefixe_matricule'] or f'{date.today().year}'
        utilises = set(par_matricule) | set(vus_matricule)
        seq = 0
        for r in sans_matricule:
            while True:
                seq += 1
                candidat = f'{prefixe}{seq:04d}'
                if normaliser_matricule(candidat) not in utilises:
                    break
            utilises.add(normaliser_matricule(candidat))
            r['donnees']['matricule'] = candidat
            r['matricule_genere'] = True

    # --- Parents ------------------------------------------------------------
    parent_defaut = None
    if options['parent_defaut'] != 'provisoire':
        try:
            parent_defaut = db.session.get(Parent, int(options['parent_defaut']))
        except (TypeError, ValueError):
            parent_defaut = None
        if not parent_defaut or parent_defaut.etablissement_id != etablissement_id:
            return {'erreur': "Parent par défaut invalide pour cet établissement."}, 400
    for r in resultats:
        p = r['donnees']['parent']
        if r['statut'] in ('erreur', 'exclu'):
            r['parent'] = None
            continue
        if r['eleve_id'] is not None and (r['statut'] != 'maj' or not p):
            # Élève existant : son parent n'est remplacé qu'en mise à jour.
            r['parent'] = 'inchange'
        elif p:
            trouve = (parent_par_email.get(p['email']) if p['email'] else None) or \
                     (parent_par_tel.get(chiffres_telephone(p['telephone'])) if len(chiffres_telephone(p['telephone'])) >= 6 else None)
            r['parent'] = 'existant' if trouve else 'nouveau'
            r['parent_libelle'] = f"{trouve.nom} {trouve.prenom}" if trouve else f"{p['nom']} {p['prenom']}".strip()
        else:
            r['parent'] = 'defaut'

    resume = Counter(r['statut'] for r in resultats)
    a_inscrire = sum(1 for r in resultats if r['statut'] not in ('erreur', 'exclu') and r['inscription'] == 'nouvelle')
    reponse = {
        'colonnes': colonnes,
        'mapping': mapping,
        'mapping_suggere': mapping_suggere,
        'champs': [{'cle': c[0], 'libelle': c[1], 'aide': c[2]} for c in CHAMPS],
        'classes_detectees': classes_detectees,
        'classes': sorted(({'id': cid, 'libelle': lib[0]} for cid, lib in classes_app.items()), key=lambda c: c['libelle']),
        'annees': [{'id': a.id, 'libelle': a.libelle, 'active': bool(a.active)} for a in sorted(annees, key=lambda a: a.libelle, reverse=True)],
        'annee_scolaire_id': annee_id,
        'lignes': resultats,
        'resume': {
            'total': len(resultats),
            'nouveaux': resume['nouveau'], 'mises_a_jour': resume['maj'], 'existants': resume['existant'],
            'erreurs': resume['erreur'], 'exclus': resume['exclu'],
            'inscriptions': a_inscrire,
            'matricules_generes': sum(1 for r in resultats if r['matricule_genere'] and r['statut'] == 'nouveau'),
            'parents_nouveaux': len({(r['donnees']['parent']['email'] or chiffres_telephone(r['donnees']['parent']['telephone'])
                                      or r['parent_libelle']) for r in resultats if r.get('parent') == 'nouveau'}),
            'avertissements': sum(1 for r in resultats if r['avertissements'] and r['statut'] not in ('erreur', 'exclu')),
        },
    }

    if not valider:
        return reponse, 200

    try:
        bilan = _enregistrer(etablissement_id, resultats, options, annee_id, parent_defaut,
                             parent_par_tel, parent_par_email)
    except Exception as exc:  # pragma: no cover - remonté proprement à l'utilisateur
        db.session.rollback()
        return {'erreur': f"L'import a échoué, rien n'a été enregistré : {exc}"}, 500
    reponse['bilan'] = bilan
    return reponse, 200


def _parent_provisoire(etablissement_id):
    email = f'parent.etab{etablissement_id}@{EMAIL_PROVISOIRE}'
    parent = Parent.query.filter_by(email=email, etablissement_id=etablissement_id).first()
    if not parent:
        parent = Parent(etablissement_id=etablissement_id, nom='PARENT', prenom='À compléter',
                        telephone='À compléter', email=email)
        db.session.add(parent)
        db.session.flush()
    return parent


def _email_libre(etablissement_id):
    return f'parent.etab{etablissement_id}.{uuid.uuid4().hex[:10]}@{EMAIL_PROVISOIRE}'


def _enregistrer(etablissement_id, resultats, options, annee_id, parent_defaut, parent_par_tel, parent_par_email):
    bilan = Counter()
    date_insc = None
    if options['date_inscription']:
        try:
            date_insc = datetime.strptime(str(options['date_inscription'])[:10], '%Y-%m-%d').date()
        except ValueError:
            date_insc = None
    date_insc = date_insc or date.today()
    parent_fallback = None

    def parent_pour(r):
        nonlocal parent_fallback
        p = r['donnees']['parent']
        if p:
            tel = chiffres_telephone(p['telephone'])
            trouve = (parent_par_email.get(p['email']) if p['email'] else None) or \
                     (parent_par_tel.get(tel) if len(tel) >= 6 else None)
            if trouve:
                return trouve
            d = r['donnees']
            parent = Parent(
                etablissement_id=etablissement_id,
                nom=p['nom'] or d['nom'][:100] or 'PARENT',
                prenom=p['prenom'] or (f"Parent de {d['prenom']}"[:100] if not p['nom'] else '-'),
                telephone=p['telephone'] or 'À compléter',
                email=p['email'] or _email_libre(etablissement_id),
            )
            if p['email'] and Parent.query.filter_by(email=p['email'], etablissement_id=etablissement_id).first():
                # Garde-fou : e-mail déjà porté par un autre parent de
                # l'établissement (uq_parent_email_etablissement).
                parent.email = _email_libre(etablissement_id)
                r['avertissements'].append("E-mail du parent déjà utilisé : e-mail provisoire attribué")
            db.session.add(parent)
            db.session.flush()
            bilan['parents_crees'] += 1
            if p['email']:
                parent_par_email[parent.email] = parent
            if len(tel) >= 6:
                parent_par_tel[tel] = parent
            return parent
        if parent_defaut is not None:
            return parent_defaut
        if parent_fallback is None:
            parent_fallback = _parent_provisoire(etablissement_id)
        return parent_fallback

    for r in resultats:
        if r['statut'] in ('erreur', 'exclu'):
            continue
        d = r['donnees']
        if r['eleve_id'] is None:
            eleve = Eleve(
                etablissement_id=etablissement_id, matricule=d['matricule'], nom=d['nom'], prenom=d['prenom'],
                sexe=d['sexe'], lieu_naissance=d['lieu_naissance'], statut=d['statut'],
                date_naissance=date.fromisoformat(d['date_naissance']) if d['date_naissance'] else None,
                parent_id=parent_pour(r).id,
            )
            db.session.add(eleve)
            db.session.flush()
            r['eleve_id'] = eleve.id
            bilan['eleves_crees'] += 1
        else:
            eleve = db.session.get(Eleve, r['eleve_id'])
            if r['statut'] == 'maj':
                for champ in r['changements']:
                    if champ == 'date_naissance':
                        eleve.date_naissance = date.fromisoformat(d['date_naissance'])
                    else:
                        setattr(eleve, champ, d[champ])
                if d['parent']:
                    eleve.parent_id = parent_pour(r).id
                bilan['eleves_mis_a_jour'] += 1
        if r['inscription'] == 'nouvelle' and annee_id and d['classe_id']:
            db.session.add(Inscription(eleve_id=eleve.id, classe_id=d['classe_id'], annee_scolaire_id=annee_id,
                                       date_inscription=date_insc, statut='Actif'))
            bilan['inscriptions_creees'] += 1
    db.session.commit()
    return dict(bilan)


# ---------------------------------------------------------------------------
# Modèle vierge à télécharger
# ---------------------------------------------------------------------------

def generer_modele_xlsx():
    import io
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation

    classeur = openpyxl.Workbook()
    feuille = classeur.active
    feuille.title = 'Élèves'
    entetes = ['Matricule', 'Nom', 'Prénom(s)', 'Sexe (M/F)', 'Date de naissance', 'Lieu de naissance', 'Classe',
               'Nom du parent', 'Téléphone du parent', 'E-mail du parent']
    feuille.append(entetes)
    feuille.append(['2026001', 'ABALA', 'Joseph', 'M', '09/02/2012', 'Yambassa', '6e A', 'ABALA Pierre', '699000000', ''])
    for cellule in feuille[1]:
        cellule.font = Font(bold=True, color='FFFFFF')
        cellule.fill = PatternFill('solid', fgColor='696CFF')
    for col, largeur in zip('ABCDEFGHIJ', (14, 22, 26, 11, 18, 20, 12, 24, 20, 26)):
        feuille.column_dimensions[col].width = largeur
    validation = DataValidation(type='list', formula1='"M,F"', allow_blank=True)
    feuille.add_data_validation(validation)
    validation.add('D2:D2000')
    feuille.freeze_panes = 'A2'

    aide = classeur.create_sheet('Aide')
    for ligne in [
        ["Comment remplir ce modèle"],
        [""],
        ["• Une ligne par élève. Vous pouvez supprimer la ligne d'exemple."],
        ["• Obligatoires : Nom, Prénom(s), Sexe. Le matricule peut être généré automatiquement à l'import."],
        ["• Dates acceptées : 09/02/2012, 2012-02-09, 9 février 2012."],
        ["• La classe doit correspondre à une classe créée dans l'application (vous pourrez l'associer à l'import)."],
        ["• Le parent est facultatif ; sans parent, l'élève est rattaché à un parent « À compléter »."],
        ["• Vous pouvez aussi importer directement vos anciens fichiers (Excel, CSV, Word) sans utiliser ce modèle."],
    ]:
        aide.append(ligne)
    aide['A1'].font = Font(bold=True, size=13)
    aide.column_dimensions['A'].width = 110

    flux = io.BytesIO()
    classeur.save(flux)
    flux.seek(0)
    return flux
