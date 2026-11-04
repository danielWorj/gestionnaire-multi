"""Import de masse des matières (groupes, matières et affectations aux
classes avec coefficient et enseignant) depuis les archives des
établissements.

Deux présentations de fichiers sont comprises :
- « en liste » : une ligne par matière, ou par matière ET classe
  (Matière | Groupe | Classe | Coefficient | Enseignant) ;
- « en grille » : une ligne par matière et une colonne par classe, la
  cellule contenant le coefficient (Matière | 6e | 5e | 4e | 3e).

Une ligne de titre de groupe au milieu du tableau (« MATIÈRES LITTÉRAIRES »
seule sur sa ligne) donne le groupe des matières qui la suivent.

Une affectation (MatiereClasse) exige une classe, un coefficient entier et un
enseignant (colonne NOT NULL) : si l'un manque, la matière est quand même
créée et l'affectation est signalée, jamais inventée.
"""

import re
from collections import Counter, defaultdict

from sqlalchemy import func

from extensions import db
from models.pedagogie_models import Enseignant, GroupeMatiere, Matiere, MatiereClasse
from models.structure_models import Classe
from services.import_commun import (
    Schema, _cle_identite, _libelles_classe, analyser_avec_schema, cle_libelle, entier, nettoyer_espaces,
    rapprocher_classe, ressemble_a_une_classe, ressemble_emploi_du_temps, retirer_civilite, valider_blocs,
)
from services.import_lecture import normaliser

CHAMPS = [
    ('matiere', 'Matière', ''),
    ('groupe', 'Groupe de matières', 'Créé s\'il n\'existe pas encore'),
    ('classe', 'Classe', 'Pour affecter la matière à une classe'),
    ('coefficient', 'Coefficient', 'Nombre entier'),
    ('enseignant', 'Enseignant', 'Retrouvé par son nom parmi les enseignants enregistrés'),
    ('coef_classe', 'Coefficient de la classe en en-tête', 'Tableau en grille : une colonne par classe'),
]

SYNONYMES = {
    'numero': ['n', 'no', 'num', 'numero', 'n d ordre', 'ordre', 'rang'],
    'horaire': ['volume horaire', 'heures', 'nombre d heures', 'h semaine', 'heures hebdomadaires',
                'heures par semaine', 'quota horaire'],
    'matiere': ['matiere', 'matieres', 'discipline', 'disciplines', 'libelle', 'libelle matiere', 'intitule',
                'enseignement', 'enseignements', 'cours', 'subject', 'subjects', 'nom de la matiere',
                'matiere enseignee', 'matieres enseignees', 'intitule de la matiere'],
    'groupe': ['groupe', 'groupes', 'groupe de matieres', 'groupe matiere', 'categorie', 'domaine', 'pole',
               'famille', 'groupe de disciplines', 'unite d enseignement', 'ue'],
    'classe': ['classe', 'classes', 'niveau', 'salle', 'division', 'cl'],
    'coefficient': ['coefficient', 'coefficients', 'coef', 'coeff', 'coefs', 'cf', 'coef matiere', 'coefficient matiere'],
    'enseignant': ['enseignant', 'enseignants', 'professeur', 'professeurs', 'prof', 'nom du professeur',
                   'nom de l enseignant', 'titulaire de la matiere', 'intervenant', 'noms et prenoms du professeur'],
}

LIMITE_LIBELLE = 150
COEF_MAX = 99

_TITRE_GROUPE = re.compile(r'^(groupe|matieres|disciplines|enseignements|domaine)\b|\bgroupe\b')


def _profil(valeurs):
    vals = [v for v in valeurs if v][:200]
    if not vals:
        return {}
    total = len(vals)
    scores = {}
    entiers = [entier(v) for v in vals]
    if all(e is not None for e in entiers) and total >= 3:
        if sum(1 for a, b in zip(entiers, entiers[1:]) if b == a + 1) >= 0.7 * (total - 1):
            scores['numero'] = 0.95
        elif all(1 <= e <= 10 for e in entiers):
            scores['coefficient'] = 0.6
    if sum(1 for v in vals if re.search(r'[a-z]', normaliser(v)) and len(v) <= 60 and not re.search(r'\d{3}', v)) / total >= 0.9 \
            and len(set(vals)) >= 0.7 * total:
        scores['matiere'] = 0.5
    return scores


def _intitule_de_classe(texte):
    """En-tête d'une grille de coefficients : « 6e A », « Tle C » (avec au
    moins une lettre : un coefficient « 4 » n'est pas un intitulé)."""
    texte = (texte or '').strip()
    return len(texte) <= 15 and bool(re.search(r'[a-z]', normaliser(texte))) and ressemble_a_une_classe(texte)


SCHEMA = Schema(CHAMPS, SYNONYMES, profil=_profil, multiples=('coef_classe',), mot_cle_extra=_intitule_de_classe)


def _scores_grille(cle, col):
    """Colonne dont l'intitulé est une classe et le contenu des coefficients
    -> « coefficient de la classe en en-tête »."""
    if re.fullmatch(r'colonne \d+', cle) or SCHEMA.score('coefficient', cle) >= 0.6 \
            or SCHEMA.score('numero', cle) >= 0.6:
        return {}
    if not ressemble_a_une_classe(col['libelle']):
        return {}
    vals = [v for v in col['valeurs'] if v]
    if vals and sum(1 for v in vals if (entier(v) or 0) >= 1 and entier(v) <= COEF_MAX) >= 0.8 * len(vals):
        return {'coef_classe': 0.85}
    return {}


def est_tableau_matieres(bloc):
    if ressemble_emploi_du_temps(bloc):
        return False
    return any(SCHEMA.score('matiere', normaliser(e)) >= 0.6 for e in bloc['entetes'] if normaliser(e))


def analyser_fichiers(fichiers, texte_colle=None):
    return analyser_avec_schema(fichiers, texte_colle, SCHEMA, pertinence=est_tableau_matieres)


# ---------------------------------------------------------------------------
# Enseignants : rapprochement par le nom
# ---------------------------------------------------------------------------

def rapprocher_enseignant(texte, enseignants):
    """« Mme ABENG », « ABENG Marie », « Marie ABENG » -> enseignant unique, ou None."""
    nom, _ = retirer_civilite(texte)
    jetons = set(normaliser(nom).split())
    if not jetons:
        return None
    exacts = [e for e in enseignants if _cle_identite(e.nom, e.prenom) == ' '.join(sorted(jetons))]
    if len(exacts) == 1:
        return exacts[0]
    inclus = [e for e in enseignants if jetons <= set(normaliser(f'{e.nom} {e.prenom}').split())]
    return inclus[0] if len(inclus) == 1 else None


# ---------------------------------------------------------------------------
# Traitement
# ---------------------------------------------------------------------------

def _options(brutes):
    o = dict(brutes or {})
    coef = entier(o.get('coefficient_defaut'))
    ens = o.get('enseignant_defaut')
    try:
        ens = int(ens) if ens not in (None, '') else None
    except (TypeError, ValueError):
        ens = None
    return {
        'groupe_defaut': nettoyer_espaces(str(o.get('groupe_defaut') or ''))[:LIMITE_LIBELLE],
        'doublons': 'mettre_a_jour' if o.get('doublons') == 'mettre_a_jour' else 'ignorer',
        'coefficient_defaut': coef if coef and 1 <= coef <= COEF_MAX else None,
        'enseignant_defaut': ens,
        'classes': {str(k): v for k, v in (o.get('classes') or {}).items()},
        'enseignants': {str(k): v for k, v in (o.get('enseignants') or {}).items()},
    }


def _vers_id(valeur, valides):
    try:
        v = int(valeur)
    except (TypeError, ValueError):
        return None
    return v if v in valides else None


def traiter(etablissement_id, payload, valider=False):
    erreur = valider_blocs(payload)
    if erreur:
        return {'erreur': erreur}, 400
    blocs = payload['blocs']
    options = _options(payload.get('options'))
    exclues = set(payload.get('exclues') or [])

    mapping_suggere, colonnes = SCHEMA.suggerer(blocs, _scores_grille)
    mapping = payload.get('mapping')
    if not isinstance(mapping, dict):
        mapping = mapping_suggere
    mapping = {cle: champ for cle, champ in mapping.items() if champ in SCHEMA.cles}
    for col in colonnes:
        col['champ'] = mapping.get(col['cle'], '')
    champs_mappes = set(mapping.values())

    # --- Référentiels --------------------------------------------------------
    groupes = GroupeMatiere.query.filter_by(etablissement_id=etablissement_id).all()
    groupe_par_cle = {cle_libelle(g.libelle): g for g in groupes}
    matieres = Matiere.query.filter_by(etablissement_id=etablissement_id).all()
    matieres_par_cle = defaultdict(list)
    for m in matieres:
        matieres_par_cle[cle_libelle(m.libelle)].append(m)
    classes = Classe.query.filter_by(etablissement_id=etablissement_id).all()
    classes_app = {c.id: _libelles_classe(c) for c in classes}
    enseignants = Enseignant.query.filter_by(etablissement_id=etablissement_id).all()
    ens_par_id = {e.id: e for e in enseignants}
    affectations = {(mc.classe_id, mc.matiere_id): mc for mc in
                    MatiereClasse.query.join(Classe, MatiereClasse.classe_id == Classe.id)
                    .filter(Classe.etablissement_id == etablissement_id).all()}
    enseignant_defaut = ens_par_id.get(options['enseignant_defaut'])

    # --- Première passe : valeurs brutes, groupes en titre, classes et
    # enseignants cités ------------------------------------------------------
    lues = list(SCHEMA.lignes(blocs, mapping, payload.get('corrections'), ('classe_id', 'enseignant_id')))

    def autres_valeurs(v, multiples):
        return [x for k, x in v.items() if x and k != 'matiere'] + [x for _, x in multiples.get('coef_classe', [])]

    # Les titres de groupe intercalés n'existent que dans les tableaux où les
    # lignes de matières portent d'autres informations (coefficients...).
    remplies = Counter()
    for _rid, _source, v, multiples, bloc in lues:
        if autres_valeurs(v, multiples):
            remplies[id(bloc)] += 1
    tailles = Counter(id(bloc) for *_x, bloc in lues)

    brutes = []
    classes_citees, enseignants_cites = Counter(), Counter()
    groupe_courant = {}
    for rid, source, v, multiples, bloc in lues:
        cle_bloc = id(bloc)
        libelle = v.get('matiere', '')
        # Ligne de titre de groupe : seule la cellule matière est remplie.
        if 'groupe' not in champs_mappes and libelle and not autres_valeurs(v, multiples) \
                and remplies[cle_bloc] >= 0.5 * tailles[cle_bloc] and _TITRE_GROUPE.search(normaliser(libelle)):
            groupe_courant[cle_bloc] = re.sub(r'^(groupe\s*\d*\s*[:\-–]?\s*)', '', libelle, flags=re.I).strip() or libelle
            continue
        couples = []
        if v.get('classe'):
            couples.append((v['classe'], v.get('coefficient', '')))
        for entete, valeur in multiples.get('coef_classe', []):
            couples.append((entete, valeur))
        for libelle_classe, _ in couples:
            if not v.get('classe_id'):
                classes_citees[libelle_classe] += 1
        if v.get('enseignant') and not v.get('enseignant_id'):
            enseignants_cites[v['enseignant']] += 1
        brutes.append((rid, source, v, couples, groupe_courant.get(cle_bloc, ''), bool(multiples.get('coef_classe'))))

    # Correspondances classes / enseignants (suggestion, ou choix de l'utilisateur)
    corr_classes, classes_detectees = {}, []
    for libelle, nb in sorted(classes_citees.items()):
        if libelle in options['classes']:
            choix, suggere = _vers_id(options['classes'][libelle], classes_app), False
        else:
            choix = rapprocher_classe(libelle, classes_app)
            suggere = choix is not None
        corr_classes[libelle] = choix
        classes_detectees.append({'libelle': libelle, 'nb': nb, 'classe_id': choix, 'suggere': suggere})
    corr_ens, enseignants_detectes = {}, []
    for libelle, nb in sorted(enseignants_cites.items()):
        if libelle in options['enseignants']:
            choix, suggere = _vers_id(options['enseignants'][libelle], ens_par_id), False
        else:
            trouve = rapprocher_enseignant(libelle, enseignants)
            choix, suggere = (trouve.id if trouve else None), trouve is not None
        corr_ens[libelle] = choix
        enseignants_detectes.append({'libelle': libelle, 'nb': nb, 'enseignant_id': choix, 'suggere': suggere})

    # --- Deuxième passe : ligne par ligne -----------------------------------
    resultats = []
    matieres_fichier = {}       # clé libellé -> {'libelle', 'groupe', 'source'}
    affect_fichier = {}         # (classe_id, clé matière) -> source
    for rid, source, v, couples, groupe_titre, grille in brutes:
        # grille : coefficients lus dans des colonnes « une par classe ».
        r = {'id': rid, 'source': source, 'erreurs': [], 'avertissements': [], 'statut': 'nouveau',
             'matiere_id': None, 'affectations': [], 'grille': grille}
        if rid in exclues:
            r['statut'] = 'exclu'
        libelle = nettoyer_espaces(v.get('matiere', '')).strip(' .:-')
        cle = cle_libelle(libelle)
        groupe = nettoyer_espaces(v.get('groupe', '')) or groupe_titre or options['groupe_defaut']

        existantes = matieres_par_cle.get(cle, [])
        existante = None
        if existantes:
            existante = next((m for m in existantes if groupe and cle_libelle(m.groupe.libelle) == cle_libelle(groupe)),
                             existantes[0])
            if groupe and cle_libelle(existante.groupe.libelle) != cle_libelle(groupe):
                r['avertissements'].append(f"Matière déjà enregistrée dans le groupe « {existante.groupe.libelle} » : groupe conservé")
            groupe = existante.groupe.libelle

        if not libelle:
            r['erreurs'].append("Nom de matière vide")
        elif len(libelle) > LIMITE_LIBELLE:
            r['erreurs'].append(f"Nom de matière trop long ({LIMITE_LIBELLE} caractères maximum)")
        if existante is None and libelle:
            deja = matieres_fichier.get(cle)
            if deja:
                r['statut'] = 'exclu' if r['statut'] == 'exclu' else 'existant'
                r['avertissements'].append(f"Matière déjà présente plus haut ({deja['source']})")
                if groupe and cle_libelle(groupe) != cle_libelle(deja['groupe']):
                    r['avertissements'].append(f"Groupe différent de la première ligne : « {deja['groupe']} » conservé")
                groupe = deja['groupe']
            else:
                if not groupe:
                    r['erreurs'].append("Groupe de matières manquant (renseignez un groupe par défaut)")
                elif len(groupe) > LIMITE_LIBELLE:
                    r['erreurs'].append(f"Nom de groupe trop long ({LIMITE_LIBELLE} caractères maximum)")
                if r['statut'] != 'exclu' and not r['erreurs']:
                    matieres_fichier[cle] = {'libelle': libelle, 'groupe': groupe, 'source': source}
        elif existante is not None:
            r['matiere_id'] = existante.id
            r['statut'] = 'exclu' if r['statut'] == 'exclu' else 'existant'
            libelle = existante.libelle
        if r['erreurs'] and r['statut'] != 'exclu':
            r['statut'] = 'erreur'

        if v.get('coefficient') and not couples and r['statut'] not in ('erreur', 'exclu'):
            r['avertissements'].append("Coefficient sans classe : ignoré (il dépend de la classe)")

        # Affectations aux classes
        for libelle_classe, brut_coef in couples:
            a = {'classe_libelle': libelle_classe, 'classe_id': None, 'coefficient': None,
                 'enseignant_id': None, 'statut': 'ignoree', 'motif': ''}
            classe_id = _vers_id(v.get('classe_id'), classes_app) if v.get('classe_id') else corr_classes.get(libelle_classe)
            coef = entier(brut_coef) if str(brut_coef).strip() else options['coefficient_defaut']
            if v.get('enseignant_id'):
                ens_id = _vers_id(v.get('enseignant_id'), ens_par_id)
            elif v.get('enseignant'):
                ens_id = corr_ens.get(v['enseignant']) or (enseignant_defaut.id if enseignant_defaut else None)
            else:
                ens_id = enseignant_defaut.id if enseignant_defaut else None
            a.update(classe_id=classe_id, coefficient=coef, enseignant_id=ens_id)
            if classe_id is None:
                a['motif'] = f"Classe « {libelle_classe} » non associée"
            elif coef is None or not (1 <= coef <= COEF_MAX):
                a['motif'] = f"Coefficient invalide « {brut_coef} »" if str(brut_coef).strip() else "Coefficient manquant"
            elif ens_id is None:
                a['motif'] = (f"Enseignant « {v['enseignant']} » non trouvé" if v.get('enseignant')
                              else "Aucun enseignant (choisissez un enseignant par défaut)")
            elif r['statut'] in ('erreur', 'exclu'):
                a['motif'] = ''
            else:
                cle_aff = (classe_id, cle)
                existante_aff = affectations.get((classe_id, r['matiere_id'])) if r['matiere_id'] else None
                if cle_aff in affect_fichier:
                    a['motif'] = f"Déjà affectée plus haut ({affect_fichier[cle_aff]})"
                elif existante_aff is not None:
                    differe = existante_aff.coefficient != coef or existante_aff.enseignant_id != ens_id
                    if differe and options['doublons'] == 'mettre_a_jour':
                        a['statut'] = 'maj'
                    else:
                        a['statut'] = 'existe'
                    affect_fichier[cle_aff] = source
                else:
                    a['statut'] = 'nouvelle'
                    affect_fichier[cle_aff] = source
            if a['motif']:
                r['avertissements'].append(a['motif'])
            a['classe_nom'] = classes_app[classe_id][0] if classe_id else ''
            a['enseignant_nom'] = f"{ens_par_id[ens_id].prenom} {ens_par_id[ens_id].nom}".strip() if ens_id else ''
            r['affectations'].append(a)

        groupe_existant = groupe_par_cle.get(cle_libelle(groupe))
        r['donnees'] = {'matiere': libelle, 'groupe': groupe_existant.libelle if groupe_existant else groupe,
                        'groupe_nouveau': bool(groupe) and groupe_existant is None}
        resultats.append(r)

    resume = Counter(r['statut'] for r in resultats)
    actifs = [r for r in resultats if r['statut'] not in ('erreur', 'exclu')]
    toutes_aff = [a for r in actifs for a in r['affectations']]
    reponse = {
        'colonnes': colonnes,
        'mapping': mapping,
        'mapping_suggere': mapping_suggere,
        'champs': SCHEMA.description_champs(),
        'groupes': sorted(g.libelle for g in groupes),
        'classes': sorted(({'id': cid, 'libelle': lib[0]} for cid, lib in classes_app.items()), key=lambda c: c['libelle']),
        'enseignants': sorted(({'id': e.id, 'libelle': f'{e.nom} {e.prenom}'.strip()} for e in enseignants), key=lambda e: e['libelle']),
        'classes_detectees': classes_detectees,
        'enseignants_detectes': enseignants_detectes,
        'lignes': resultats,
        'resume': {
            'total': len(resultats),
            'nouveaux': resume['nouveau'], 'mises_a_jour': 0, 'existants': resume['existant'],
            'erreurs': resume['erreur'], 'exclus': resume['exclu'],
            'groupes_nouveaux': len({cle_libelle(r['donnees']['groupe']) for r in actifs
                                     if r['statut'] == 'nouveau' and r['donnees']['groupe_nouveau']}),
            'affectations_nouvelles': sum(1 for a in toutes_aff if a['statut'] == 'nouvelle'),
            'affectations_maj': sum(1 for a in toutes_aff if a['statut'] == 'maj'),
            'affectations_ignorees': sum(1 for a in toutes_aff if a['statut'] == 'ignoree'),
            'avertissements': sum(1 for r in actifs if r['avertissements']),
        },
    }
    if not valider:
        return reponse, 200

    try:
        bilan = _enregistrer(etablissement_id, resultats, groupe_par_cle, matieres_par_cle, affectations)
    except Exception as exc:  # pragma: no cover - remonté proprement à l'utilisateur
        db.session.rollback()
        return {'erreur': f"L'import a échoué, rien n'a été enregistré : {exc}"}, 500
    reponse['bilan'] = bilan
    return reponse, 200


def _enregistrer(etablissement_id, resultats, groupe_par_cle, matieres_par_cle, affectations):
    bilan = Counter()
    ordre = (db.session.query(func.max(GroupeMatiere.ordre))
             .filter(GroupeMatiere.etablissement_id == etablissement_id).scalar() or 0)
    creees = {}
    for r in resultats:
        if r['statut'] in ('erreur', 'exclu'):
            continue
        d = r['donnees']
        cle = cle_libelle(d['matiere'])
        matiere = None
        if r['matiere_id']:
            matiere = db.session.get(Matiere, r['matiere_id'])
        elif cle in creees:
            matiere = creees[cle]
        elif r['statut'] == 'nouveau':
            cle_groupe = cle_libelle(d['groupe'])
            groupe = groupe_par_cle.get(cle_groupe)
            if groupe is None:
                ordre += 1
                groupe = GroupeMatiere(etablissement_id=etablissement_id, libelle=d['groupe'], ordre=ordre)
                db.session.add(groupe)
                db.session.flush()
                groupe_par_cle[cle_groupe] = groupe
                bilan['groupes_crees'] += 1
            matiere = Matiere(etablissement_id=etablissement_id, libelle=d['matiere'], groupe_id=groupe.id)
            db.session.add(matiere)
            db.session.flush()
            creees[cle] = matiere
            bilan['matieres_creees'] += 1
        if matiere is None:
            continue
        r['matiere_id'] = matiere.id
        for a in r['affectations']:
            if a['statut'] == 'nouvelle':
                mc = MatiereClasse(classe_id=a['classe_id'], matiere_id=matiere.id,
                                   enseignant_id=a['enseignant_id'], coefficient=a['coefficient'])
                db.session.add(mc)
                affectations[(a['classe_id'], matiere.id)] = mc
                bilan['affectations_creees'] += 1
            elif a['statut'] == 'maj':
                mc = affectations[(a['classe_id'], matiere.id)]
                mc.coefficient = a['coefficient']
                mc.enseignant_id = a['enseignant_id']
                bilan['affectations_mises_a_jour'] += 1
    db.session.commit()
    return dict(bilan)


def generer_modele_xlsx():
    from services.import_modeles import modele_xlsx
    return modele_xlsx(
        'Matières',
        ['Matière', 'Groupe', 'Classe', 'Coefficient', 'Enseignant'],
        [['Mathématiques', 'Matières scientifiques', '6e A', 4, 'ABENG Marie'],
         ['Anglais', 'Matières littéraires', '6e A', 2, 'AKAMBA Paul']],
        largeurs=(26, 26, 14, 13, 26),
        aide=[
            "• Une ligne par matière et par classe. Pour créer seulement les matières, laissez Classe, Coefficient et Enseignant vides.",
            "• Les groupes de matières absents de l'application sont créés automatiquement.",
            "• Une affectation à une classe demande une classe existante, un coefficient entier et un enseignant enregistré (retrouvé par son nom).",
            "• Présentation en grille acceptée : Matière | 6e A | 5e A | … avec le coefficient dans chaque case.",
            "• Vous pouvez aussi importer directement vos anciens fichiers (Excel, CSV, Word).",
        ],
    )
