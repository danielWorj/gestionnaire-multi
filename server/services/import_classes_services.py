"""Import de masse des classes (Configuration) depuis les archives des
établissements.

Une classe de l'application = un cycle (« Premier cycle ») + un libellé
(Classe.option : « 6e A », « MACO 2 »). Les classes à créer sont trouvées :
- dans une colonne « Classe » (un fichier listant les classes, ou une liste
  d'élèves/enseignants avec leur classe : chaque classe n'est créée qu'une fois) ;
- et/ou, en option, dans le titre des tableaux ou le nom des fichiers (ex. les
  listes « LISTE PROVISOIRE MACO 2.docx » donnent la classe « MACO 2 »).

Le cycle vient d'une colonne « Cycle », sinon il est déduit du nom de la
classe (6e-3e -> premier cycle, 2nde-Tle -> second cycle), sinon c'est le
cycle par défaut choisi par l'utilisateur.

Une classe déjà présente (mêmes mots, quel que soit l'écriture : « 6ème A » =
« 6e A ») n'est jamais recréée.
"""

import re
from collections import Counter

from extensions import db
from models.structure_models import Classe, Cycle
from services.import_commun import (
    Schema, _libelles_classe, analyser_avec_schema, cle_libelle, jetons_classe, nettoyer_espaces,
    rapprocher_classe, ressemble_a_une_classe, ressemble_emploi_du_temps, valider_blocs,
)
from services.import_lecture import normaliser

CHAMPS = [
    ('classe', 'Classe', '« 6e A », « Tle C », « MACO 2 »…'),
    ('cycle', 'Cycle', 'Créé s\'il n\'existe pas encore'),
]

SYNONYMES = {
    'numero': ['n', 'no', 'num', 'numero', 'n d ordre', 'ordre', 'rang'],
    'classe': ['classe', 'classes', 'libelle', 'libelle classe', 'nom de la classe', 'salle', 'salle de classe',
               'division', 'niveau et section', 'classe frequentee', 'classe actuelle', 'cl'],
    'cycle': ['cycle', 'cycles', 'niveau d enseignement', 'ordre d enseignement', 'sous cycle'],
    # Pseudo-champs : aident à repérer l'en-tête d'un tableau de classes.
    'effectif': ['effectif', 'effectifs', 'nombre d eleves', 'nb eleves', 'garcons', 'filles', 'total'],
    'titulaire': ['titulaire', 'professeur principal', 'prof principal', 'enseignant titulaire'],
}

LIMITE_LIBELLE = 50
LIMITE_CYCLE = 50


def _profil(valeurs):
    vals = [v for v in valeurs if v][:200]
    if not vals:
        return {}
    total = len(vals)
    # « 6e A », « Tle D », « MACO 2 », « Form 1 » : courts, avec des lettres,
    # un chiffre ou un niveau connu, et beaucoup de répétitions (une classe
    # par élève). Jamais une colonne de numéros d'ordre (1, 2, 3...).
    courtes = sum(1 for v in vals if len(v) <= 15 and re.search(r'[a-z]', normaliser(v))
                  and ressemble_a_une_classe(v))
    if courtes / total >= 0.8 and len(set(vals)) <= max(3, total * 0.6):
        return {'classe': 0.6}
    return {}


SCHEMA = Schema(CHAMPS, SYNONYMES, profil=_profil)


def est_tableau_utile(bloc):
    """Tout tableau ayant une colonne de classes, ou un titre de classe —
    sauf les grilles d'emploi du temps (cellules « ESCOM3 ESF3 »...)."""
    if ressemble_emploi_du_temps(bloc):
        return False
    for entete in bloc['entetes']:
        n = normaliser(entete)
        if n and SCHEMA.score('classe', n) >= 0.6:
            return True
    return ressemble_a_une_classe(bloc.get('classe_detectee'))


def analyser_fichiers(fichiers, texte_colle=None):
    return analyser_avec_schema(fichiers, texte_colle, SCHEMA, pertinence=est_tableau_utile)


# ---------------------------------------------------------------------------
# Déduction du cycle
# ---------------------------------------------------------------------------

def niveau_cycle(libelle):
    """'premier', 'second' ou None, d'après le nom d'une classe de
    l'enseignement général (« 6e A » -> premier, « Tle C » -> second)."""
    n = normaliser(libelle)
    n = re.sub(r'^(\d)\s*(e|eme|em|er|ere|nde|nd)\b', r'\1', n)
    if re.match(r'^(seconde|2nde|premiere|1ere|tle|terminale|lower|upper)\b', n):
        return 'second'
    if re.match(r'^[6543]\b', n) or re.match(r'^(sixieme|cinquieme|quatrieme|troisieme|form ?[1-5])\b', n):
        return 'premier'
    if re.match(r'^[21]\b', n) and not re.search(r'\bannee\b', n):
        # « 2nde A », « 1ère C » ; mais pas « 2e année » (enseignement technique).
        return 'second'
    return None


def _cycle_type(cycle):
    n = normaliser(cycle.libelle)
    if re.search(r'\b(premier|1er|1|first|1st)\b', n):
        return 'premier'
    if re.search(r'\b(second|2nd|deuxieme|2|second cycle)\b', n):
        return 'second'
    return None


# ---------------------------------------------------------------------------
# Traitement
# ---------------------------------------------------------------------------

def _options(brutes):
    o = dict(brutes or {})
    return {
        'depuis_titres': bool(o.get('depuis_titres', True)),
        'cycle_auto': bool(o.get('cycle_auto', True)),
        'cycle_defaut': nettoyer_espaces(str(o.get('cycle_defaut') or ''))[:LIMITE_CYCLE],
        'majuscules': bool(o.get('majuscules', False)),
    }


def _libelle_propre(texte, majuscules):
    texte = nettoyer_espaces(texte).strip(' .-')
    return texte.upper() if majuscules else texte


def traiter(etablissement_id, payload, valider=False):
    erreur = valider_blocs(payload)
    if erreur:
        return {'erreur': erreur}, 400
    blocs = payload['blocs']
    options = _options(payload.get('options'))
    exclues = set(payload.get('exclues') or [])
    corrections = payload.get('corrections') or {}

    mapping_suggere, colonnes = SCHEMA.suggerer(blocs)
    mapping = payload.get('mapping')
    if not isinstance(mapping, dict):
        mapping = mapping_suggere
    mapping = {cle: champ for cle, champ in mapping.items() if champ in SCHEMA.cles}
    for col in colonnes:
        col['champ'] = mapping.get(col['cle'], '')
    a_colonne_classe = 'classe' in mapping.values()

    cycles = Cycle.query.filter_by(etablissement_id=etablissement_id).all()
    cycle_par_cle = {cle_libelle(c.libelle): c for c in cycles}
    cycle_par_type = {}
    for c in cycles:
        t = _cycle_type(c)
        if t and t not in cycle_par_type:
            cycle_par_type[t] = c
    classes = Classe.query.filter_by(etablissement_id=etablissement_id).all()
    classes_app = {c.id: _libelles_classe(c) for c in classes}

    # --- Collecte des classes distinctes ------------------------------------
    # Clé de regroupement : les mots de la classe (« 6ème A » == « 6e A »).
    trouvees = {}

    def ajouter(libelle, cycle, source):
        libelle = _libelle_propre(libelle, options['majuscules'])
        if not libelle:
            return
        cle = ' '.join(sorted(jetons_classe(libelle))) or cle_libelle(libelle)
        t = trouvees.get(cle)
        if t is None:
            trouvees[cle] = {'id': cle, 'libelle': libelle, 'cycle': cycle, 'sources': [source], 'nb': 1}
        else:
            t['nb'] += 1
            if len(t['sources']) < 3 and source not in t['sources']:
                t['sources'].append(source)
            if cycle and not t['cycle']:
                t['cycle'] = cycle

    if a_colonne_classe:
        for _rid, source, v, _m, _bloc in SCHEMA.lignes(blocs, mapping):
            if v.get('classe'):
                ajouter(v['classe'], v.get('cycle', ''), source)
    if options['depuis_titres'] or not a_colonne_classe:
        for bloc in blocs:
            if ressemble_a_une_classe(bloc.get('classe_detectee')):
                ajouter(bloc['classe_detectee'], '', bloc.get('source') or 'Fichier')

    # --- Ligne par ligne (une ligne = une classe) ---------------------------
    resultats = []
    vus_creation = {}
    for cle, t in sorted(trouvees.items(), key=lambda kv: kv[1]['libelle']):
        r = {'id': cle, 'source': ', '.join(t['sources']), 'nb': t['nb'], 'erreurs': [], 'avertissements': [],
             'statut': 'nouveau', 'classe_id': None}
        corr = corrections.get(cle) or {}
        libelle = _libelle_propre(corr.get('classe') or t['libelle'], options['majuscules'])
        cycle_txt = nettoyer_espaces(corr['cycle']) if corr.get('cycle') else nettoyer_espaces(t['cycle'])
        if cle in exclues:
            r['statut'] = 'exclu'

        # Classe déjà présente ?
        jetons = sorted(jetons_classe(libelle))
        existante = None
        for classe in classes:
            # Identité d'une classe existante : son libellé (Classe.option),
            # ou son cycle s'il n'a pas de libellé. Jamais le cycle seul
            # quand un libellé existe (« Premier cycle » ≠ « 1ère C »).
            reference = classe.option or (classe.cycle.libelle if classe.cycle else '')
            if jetons and sorted(jetons_classe(reference)) == jetons:
                existante = classe.id
                break
        if existante is None and jetons:
            proche = rapprocher_classe(libelle, classes_app)
            if proche:
                r['avertissements'].append(f"Ressemble à la classe existante « {classes_app[proche][0]} » : "
                                           "excluez cette ligne s'il s'agit de la même")

        # Cycle
        cycle_obj, cycle_libelle, cycle_nouveau, origine = None, '', False, ''
        if cycle_txt:
            cycle_obj = cycle_par_cle.get(cle_libelle(cycle_txt))
            cycle_libelle, origine = (cycle_obj.libelle if cycle_obj else cycle_txt), 'fichier'
        elif options['cycle_auto'] and niveau_cycle(libelle):
            niveau = niveau_cycle(libelle)
            cycle_obj = cycle_par_type.get(niveau)
            cycle_libelle = cycle_obj.libelle if cycle_obj else ('Premier cycle' if niveau == 'premier' else 'Second cycle')
            origine = 'deduit'
        elif options['cycle_defaut']:
            cycle_obj = cycle_par_cle.get(cle_libelle(options['cycle_defaut']))
            cycle_libelle = cycle_obj.libelle if cycle_obj else options['cycle_defaut']
            origine = 'defaut'
        if cycle_libelle and cycle_obj is None:
            cycle_nouveau = True

        if existante is not None:
            r['classe_id'] = existante
            r['statut'] = 'exclu' if r['statut'] == 'exclu' else 'existant'
            classe = next(c for c in classes if c.id == existante)
            cycle_libelle, cycle_nouveau, origine = (classe.cycle.libelle if classe.cycle else ''), False, 'existant'
        else:
            if not libelle:
                r['erreurs'].append("Libellé de classe vide")
            if len(libelle) > LIMITE_LIBELLE:
                r['erreurs'].append(f"Libellé trop long ({LIMITE_LIBELLE} caractères maximum)")
            if not cycle_libelle:
                r['erreurs'].append("Cycle inconnu : choisissez un cycle par défaut ou corrigez la ligne")
            elif len(cycle_libelle) > LIMITE_CYCLE:
                r['erreurs'].append(f"Libellé de cycle trop long ({LIMITE_CYCLE} caractères maximum)")
            cle_creation = (cle_libelle(cycle_libelle), ' '.join(jetons) or cle_libelle(libelle))
            if r['statut'] != 'exclu' and not r['erreurs']:
                if cle_creation in vus_creation:
                    r['erreurs'].append(f"Classe en double (« {vus_creation[cle_creation]} »)")
                vus_creation.setdefault(cle_creation, libelle)
        if r['erreurs'] and r['statut'] != 'exclu':
            r['statut'] = 'erreur'

        r['donnees'] = {'classe': libelle, 'cycle': cycle_libelle, 'cycle_nouveau': cycle_nouveau,
                        'cycle_origine': origine}
        resultats.append(r)

    resume = Counter(r['statut'] for r in resultats)
    actifs = [r for r in resultats if r['statut'] == 'nouveau']
    reponse = {
        'colonnes': colonnes,
        'mapping': mapping,
        'mapping_suggere': mapping_suggere,
        'champs': SCHEMA.description_champs(),
        'cycles': sorted(c.libelle for c in cycles),
        'lignes': resultats,
        'resume': {
            'total': len(resultats),
            'nouveaux': resume['nouveau'], 'mises_a_jour': 0, 'existants': resume['existant'],
            'erreurs': resume['erreur'], 'exclus': resume['exclu'],
            'cycles_nouveaux': len({cle_libelle(r['donnees']['cycle']) for r in actifs if r['donnees']['cycle_nouveau']}),
            'avertissements': sum(1 for r in resultats if r['avertissements'] and r['statut'] not in ('erreur', 'exclu')),
        },
    }
    if not valider:
        return reponse, 200

    try:
        bilan = Counter()
        for r in actifs:
            d = r['donnees']
            cle_cycle = cle_libelle(d['cycle'])
            cycle = cycle_par_cle.get(cle_cycle)
            if cycle is None:
                cycle = Cycle(etablissement_id=etablissement_id, libelle=d['cycle'])
                db.session.add(cycle)
                db.session.flush()
                cycle_par_cle[cle_cycle] = cycle
                bilan['cycles_crees'] += 1
            classe = Classe(etablissement_id=etablissement_id, cycle_id=cycle.id, option=d['classe'])
            db.session.add(classe)
            db.session.flush()
            r['classe_id'] = classe.id
            bilan['classes_creees'] += 1
        db.session.commit()
    except Exception as exc:  # pragma: no cover - remonté proprement à l'utilisateur
        db.session.rollback()
        return {'erreur': f"L'import a échoué, rien n'a été enregistré : {exc}"}, 500
    reponse['bilan'] = dict(bilan)
    return reponse, 200


def generer_modele_xlsx():
    from services.import_modeles import modele_xlsx
    return modele_xlsx(
        'Classes',
        ['Classe', 'Cycle'],
        [['6e A', 'Premier cycle'], ['Tle C', 'Second cycle']],
        largeurs=(20, 24),
        aide=[
            "• Une ligne par classe. Vous pouvez supprimer les lignes d'exemple.",
            "• Le cycle est facultatif : 6e à 3e vont dans le premier cycle, 2nde à Tle dans le second ; sinon un cycle par défaut est demandé à l'import.",
            "• Les cycles absents de l'application sont créés automatiquement.",
            "• Une classe déjà enregistrée n'est jamais recréée.",
            "• Vous pouvez aussi importer vos listes d'élèves : chaque classe trouvée (colonne ou titre « LISTE DES ÉLÈVES DE 6e A ») est proposée.",
        ],
    )
