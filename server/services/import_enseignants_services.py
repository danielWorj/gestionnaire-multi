"""Import de masse des enseignants depuis les archives des établissements
(listes du personnel en Excel/CSV/Word, ou fiches Word « NOMS ET PRENOMS :
Mme ABENG — GRADE : PLET — CONTACT : 6965... »).

Même principe que import_eleves_services.py : l'aperçu et l'import passent
par le même traitement (traiter), seule l'écriture finale diffère.

Spécificités :
- département et grade sont obligatoires (Enseignant.departement_id /
  grade_id) : retrouvés par libellé, créés s'ils n'existent pas, ou valeur
  par défaut choisie par l'utilisateur ;
- la civilité (M., Mme, Mlle) donne le sexe ;
- un compte de connexion (rôle Enseignant, code + PIN temporaire) peut être
  créé pour chaque enseignant : les identifiants sont renvoyés UNE SEULE FOIS
  dans le bilan, comme pour une création individuelle.
"""

import re
from collections import Counter
from datetime import datetime, timedelta

from sqlalchemy import func

from extensions import db
from models.authentification_models import (
    TEMP_PASSWORD_VALIDITY_HOURS, Role, Utilisateur, generate_temp_pin,
)
from models.pedagogie_models import Departement, Enseignant, Grade
from services.import_commun import (
    Schema, _cle_identite, analyser_avec_schema, casse_prenom, chiffres_telephone, cle_libelle,
    email_valide, nettoyer_espaces, parser_sexe, premier_telephone, retirer_civilite,
    separer_nom_complet, valider_blocs,
)
from services.import_lecture import normaliser

CHAMPS = [
    ('nom_complet', 'Nom et prénom(s) dans une même colonne', 'Une civilité (M., Mme, Mlle) en tête donne le sexe'),
    ('nom', 'Nom', ''),
    ('prenom', 'Prénom(s)', ''),
    ('civilite', 'Civilité (M., Mme, Mlle)', 'Donne le sexe'),
    ('sexe', 'Sexe', 'M/F, Masculin/Féminin…'),
    ('telephone', 'Téléphone', ''),
    ('email', 'E-mail', ''),
    ('departement', 'Département / spécialité', 'Créé s\'il n\'existe pas encore'),
    ('grade', 'Grade', 'Créé s\'il n\'existe pas encore'),
]

SYNONYMES = {
    'numero': ['n', 'no', 'num', 'numero', 'n d ordre', 'no d ordre', 'numero d ordre', 'ordre', 'rang', 'n o'],
    # Pseudo-champs : reconnus pour repérer l'en-tête, jamais importés
    # (Enseignant n'a ni matricule ni volume horaire).
    'matricule': ['matricule', 'mle', 'n matricule', 'no matricule', 'matricule enseignant', 'matricule solde'],
    'horaire': ['heures dues', 'heures faites', 'volume horaire', 'heures', 'nombre d heures', 'charge horaire'],
    'nom_complet': ['noms et prenoms', 'nom et prenoms', 'nom et prenom', 'noms et prenom', 'nom prenom', 'nom prenoms',
                    'noms prenoms', 'nom s et prenom s', 'nom complet', 'noms', 'enseignant', 'enseignants',
                    'professeur', 'professeurs', 'nom de l enseignant', 'noms et prenoms de l enseignant',
                    'nom et prenom de l enseignant', 'noms et prenoms des enseignants', 'identite', 'personnel',
                    'noms et prenoms du personnel', 'full name', 'name', 'intervenant'],
    'nom': ['nom', 'nom de famille', 'surname', 'last name', 'family name'],
    'prenom': ['prenom', 'prenoms', 'prenom s', 'first name', 'given name'],
    'civilite': ['civilite', 'civ', 'titre', 'm mme', 'mr mme'],
    'sexe': ['sexe', 'sex', 's', 'genre', 'gender', 'm f', 'sexe m f'],
    'telephone': ['telephone', 'tel', 'contact', 'contacts', 'portable', 'cel', 'cell', 'cellulaire', 'mobile', 'phone',
                  'numero de telephone', 'n telephone', 'n de telephone', 'whatsapp', 'tel portable', 'n tel'],
    'email': ['email', 'e mail', 'mail', 'courriel', 'adresse email', 'adresse e mail', 'adresse mail'],
    'departement': ['departement', 'departements', 'dept', 'departement pedagogique', 'specialite', 'specialites',
                    'discipline', 'disciplines', 'fonction specialite', 'filiere', 'unite pedagogique',
                    'animation pedagogique', 'section'],
    'grade': ['grade', 'grades', 'corps', 'statut', 'categorie', 'qualification', 'grade enseignant', 'cadre'],
}

LIMITES = {'nom': 100, 'prenom': 100, 'telephone': 20, 'email': 150}


def parser_civilite(valeur):
    """« Mme » -> 'F', « M. » -> 'M', « Dr » -> None."""
    return retirer_civilite(f'{valeur} x')[1]


def _profil(valeurs):
    vals = [v for v in valeurs if v][:200]
    if not vals:
        return {}
    total = len(vals)
    frac = lambda pred: sum(1 for v in vals if pred(v)) / total  # noqa: E731
    scores = {}
    if frac(lambda v: parser_sexe(v) in ('M', 'F') and len(v) <= 9) >= 0.8:
        scores['sexe'] = 0.9
    # Colonne ne contenant QUE la civilité (« Mme », « M. »), pas « Mme ABENG ».
    if frac(lambda v: retirer_civilite(v + ' x') == ('x', parser_civilite(v))
            and parser_civilite(v) is not None) >= 0.8:
        scores['civilite'] = 0.9
    if frac(lambda v: bool(email_valide(v))) >= 0.6:
        scores['email'] = 0.9
    if frac(lambda v: re.fullmatch(r'[+\d][\d\s.\-/]{7,20}', v) is not None and len(re.sub(r'\D', '', v)) >= 8) >= 0.7:
        scores['telephone'] = 0.8
    entiers = [v for v in vals if re.fullmatch(r'\d{1,4}\.?', v)]
    if len(entiers) == total and total >= 3:
        nums = [int(v.rstrip('.')) for v in entiers]
        if sum(1 for a, b in zip(nums, nums[1:]) if b == a + 1) >= 0.7 * (total - 1):
            scores['numero'] = 0.95
    if frac(lambda v: len(v.split()) >= 2 and re.search(r'\d', v) is None) >= 0.8:
        scores['nom_complet'] = 0.5
    return scores


SCHEMA = Schema(CHAMPS, SYNONYMES, profil=_profil, combines=[('nom_complet', ('nom', 'prenom'))])

_ENTETES_ELEVES = re.compile(r'\b(naissance|classe|parent|tuteur|redoublant)\b')


def est_liste_enseignants(bloc):
    """Un tableau d'emploi du temps, de notes ou une liste d'élèves ne doit
    pas être importé comme liste d'enseignants."""
    trouves = set()
    eleves = False
    for entete in bloc['entetes']:
        n = normaliser(entete)
        if not n or re.fullmatch(r'colonne \d+', n):
            continue
        if _ENTETES_ELEVES.search(n):
            eleves = True
        for champ in SYNONYMES:
            if SCHEMA.score(champ, n) >= 0.6:
                trouves.add(champ)
    if not ({'nom_complet', 'nom'} & trouves):
        return False
    pro = {'telephone', 'email', 'grade', 'departement', 'civilite', 'horaire'} & trouves
    if pro:
        return True
    return not eleves and ('sexe' in trouves or 'matricule' in trouves)


def analyser_fichiers(fichiers, texte_colle=None):
    return analyser_avec_schema(fichiers, texte_colle, SCHEMA, fiches=True, pertinence=est_liste_enseignants)


# ---------------------------------------------------------------------------
# Traitement
# ---------------------------------------------------------------------------

def _options(brutes):
    o = dict(brutes or {})
    return {
        'separation': o.get('separation') if o.get('separation') in ('premier', 'deux', 'dernier') else 'premier',
        'harmoniser_casse': bool(o.get('harmoniser_casse', True)),
        'doublons': 'mettre_a_jour' if o.get('doublons') == 'mettre_a_jour' else 'ignorer',
        'sexe_defaut': o.get('sexe_defaut') if o.get('sexe_defaut') in ('M', 'F') else None,
        'prenom_absent': 'tiret' if o.get('prenom_absent') == 'tiret' else 'erreur',
        'departement_defaut': nettoyer_espaces(str(o.get('departement_defaut') or ''))[:150],
        'grade_defaut': nettoyer_espaces(str(o.get('grade_defaut') or ''))[:150],
        'creer_comptes': bool(o.get('creer_comptes', True)),
    }


def traiter(etablissement_id, payload, valider=False):
    erreur = valider_blocs(payload)
    if erreur:
        return {'erreur': erreur}, 400
    blocs = payload['blocs']
    options = _options(payload.get('options'))
    exclues = set(payload.get('exclues') or [])

    mapping_suggere, colonnes = SCHEMA.suggerer(blocs)
    mapping = payload.get('mapping')
    if not isinstance(mapping, dict):
        mapping = mapping_suggere
    mapping = {cle: champ for cle, champ in mapping.items() if champ in SCHEMA.cles}
    for col in colonnes:
        col['champ'] = mapping.get(col['cle'], '')

    # --- Référentiels de l'établissement -----------------------------------
    departements = Departement.query.filter_by(etablissement_id=etablissement_id).all()
    grades = Grade.query.filter_by(etablissement_id=etablissement_id).all()
    dep_par_cle = {cle_libelle(d.libelle): d for d in departements}
    grade_par_cle = {cle_libelle(g.libelle): g for g in grades}

    enseignants = Enseignant.query.filter_by(etablissement_id=etablissement_id).all()
    par_email = {e.email.lower(): e for e in enseignants if e.email}
    par_tel = {chiffres_telephone(e.telephone): e for e in enseignants if len(chiffres_telephone(e.telephone)) >= 8}
    par_identite, par_nom = {}, {}
    for e in enseignants:
        par_identite.setdefault(_cle_identite(e.nom, e.prenom), []).append(e)
        par_nom.setdefault(normaliser(e.nom), []).append(e)

    role_enseignant = Role.query.filter_by(libelle='Enseignant').first()

    resultats = []
    vus = {}
    for rid, source, v, _multiples, _bloc in SCHEMA.lignes(blocs, mapping, payload.get('corrections'), ('nom', 'prenom')):
        r = {'id': rid, 'source': source, 'erreurs': [], 'avertissements': [], 'statut': 'nouveau',
             'enseignant_id': None, 'changements': []}
        if rid in exclues:
            r['statut'] = 'exclu'

        # Nom, prénom, civilité
        sexe_civilite = None
        nom, prenom = v.get('nom', ''), v.get('prenom', '')
        if nom:
            nom, s = retirer_civilite(nom)
            sexe_civilite = sexe_civilite or s
        if v.get('nom_complet') and not (nom and prenom):
            texte, s = retirer_civilite(v['nom_complet'])
            sexe_civilite = sexe_civilite or s
            n2, p2 = separer_nom_complet(texte, options['separation'])
            nom, prenom = nom or n2, prenom or p2
        if v.get('civilite'):
            sexe_civilite = parser_civilite(v['civilite']) or sexe_civilite
        nom, prenom = nettoyer_espaces(nom), nettoyer_espaces(prenom)
        if options['harmoniser_casse']:
            nom, prenom = nom.upper(), casse_prenom(prenom)
        prenom_tiret = False
        if nom and not prenom and options['prenom_absent'] == 'tiret':
            prenom, prenom_tiret = '-', True

        # Sexe
        sexe = parser_sexe(v.get('sexe', ''))
        sexe_invalide = sexe is False
        if sexe in (None, False):
            sexe = sexe_civilite

        telephone = premier_telephone(v.get('telephone', ''))
        email = email_valide(v.get('email', ''))
        if v.get('email') and not email:
            r['avertissements'].append(f"E-mail invalide « {v.get('email')} », ignoré")

        departement = nettoyer_espaces(v.get('departement', '')) or options['departement_defaut']
        grade = nettoyer_espaces(v.get('grade', '')) or options['grade_defaut']

        # Enseignant déjà enregistré ?
        existant, motif = None, ''
        if email and email in par_email:
            existant, motif = par_email[email], 'e-mail'
        elif len(chiffres_telephone(telephone)) >= 8 and chiffres_telephone(telephone) in par_tel:
            existant, motif = par_tel[chiffres_telephone(telephone)], 'téléphone'
        elif nom and prenom and not prenom_tiret:
            homonymes = par_identite.get(_cle_identite(nom, prenom), [])
            if len(homonymes) == 1:
                existant, motif = homonymes[0], 'nom et prénom'
        elif nom:
            homonymes = par_nom.get(normaliser(nom), [])
            if len(homonymes) == 1:
                existant, motif = homonymes[0], 'nom'
        if existant is not None and motif in ('nom', 'nom et prénom'):
            r['avertissements'].append(f"Reconnu par son {motif} : vérifiez qu'il s'agit bien de "
                                       f"{existant.prenom} {existant.nom}")

        # Doublons dans les fichiers
        cles = [k for k in (('e', email) if email else None,
                            ('t', chiffres_telephone(telephone)) if len(chiffres_telephone(telephone)) >= 8 else None,
                            ('i', _cle_identite(nom, '' if prenom_tiret else prenom)) if nom else None) if k]
        if r['statut'] != 'exclu':
            deja = next((vus[k] for k in cles if k in vus), None)
            if deja:
                r['erreurs'].append(f"Enseignant en double ({deja})")
            for k in cles:
                vus.setdefault(k, source)

        dep_cle, grade_cle = cle_libelle(departement), cle_libelle(grade)
        donnees = {
            'nom': nom, 'prenom': prenom, 'sexe': sexe, 'telephone': telephone, 'email': email,
            'departement': dep_par_cle[dep_cle].libelle if dep_cle in dep_par_cle else departement,
            'departement_nouveau': bool(departement) and dep_cle not in dep_par_cle,
            'grade': grade_par_cle[grade_cle].libelle if grade_cle in grade_par_cle else grade,
            'grade_nouveau': bool(grade) and grade_cle not in grade_par_cle,
        }

        if existant is not None:
            r['enseignant_id'] = existant.id
            r['statut'] = 'exclu' if r['statut'] == 'exclu' else 'existant'
            if options['doublons'] == 'mettre_a_jour':
                for champ in ('nom', 'prenom', 'sexe', 'telephone'):
                    valeur = donnees[champ]
                    if valeur and valeur != getattr(existant, champ) and not (champ == 'prenom' and prenom_tiret) \
                            and len(valeur) <= LIMITES.get(champ, 999):
                        r['changements'].append(champ)
                if email and email != (existant.email or '').lower():
                    autre = Enseignant.query.filter(func.lower(Enseignant.email) == email,
                                                    Enseignant.etablissement_id == etablissement_id,
                                                    Enseignant.id != existant.id).first()
                    if autre:
                        r['avertissements'].append("E-mail déjà utilisé par un autre enseignant : non modifié")
                    else:
                        r['changements'].append('email')
                if departement and dep_cle not in (cle_libelle(existant.departement.libelle),):
                    r['changements'].append('departement')
                if grade and grade_cle not in (cle_libelle(existant.grade.libelle),):
                    r['changements'].append('grade')
                if r['changements'] and r['statut'] != 'exclu':
                    r['statut'] = 'maj'
        else:
            if not nom:
                r['erreurs'].append("Nom manquant")
            if not prenom:
                r['erreurs'].append("Prénom manquant (ou choisissez « Prénom absent : mettre un tiret »)")
            if sexe_invalide and not sexe:
                r['erreurs'].append(f"Sexe non reconnu « {v.get('sexe')} »")
            elif not sexe:
                if options['sexe_defaut']:
                    donnees['sexe'] = options['sexe_defaut']
                    r['avertissements'].append("Sexe absent : valeur par défaut appliquée")
                else:
                    r['erreurs'].append("Sexe manquant (colonne Sexe, civilité M./Mme, ou valeur par défaut)")
            if not departement:
                r['erreurs'].append("Département manquant (renseignez un département par défaut)")
            if not grade:
                r['erreurs'].append("Grade manquant (renseignez un grade par défaut)")
            for champ, maxi in LIMITES.items():
                if len(donnees[champ] or '') > maxi:
                    r['erreurs'].append(f"{champ.capitalize()} trop long ({maxi} caractères maximum)")
        if len(departement) > 150 or len(grade) > 150:
            r['erreurs'].append("Libellé de département ou de grade trop long (150 caractères maximum)")
        if r['erreurs'] and r['statut'] != 'exclu':
            r['statut'] = 'erreur'

        # Compte de connexion
        if r['statut'] in ('erreur', 'exclu') or not options['creer_comptes']:
            r['compte'] = 'non'
        elif existant is not None and existant.utilisateur_id:
            r['compte'] = 'deja'
        else:
            r['compte'] = 'a_creer'
        r['donnees'] = donnees
        resultats.append(r)

    if options['creer_comptes'] and not role_enseignant:
        return {'erreur': "Rôle « Enseignant » introuvable : lancez l'initialisation des rôles (flask init-roles)."}, 500

    actifs = [r for r in resultats if r['statut'] not in ('erreur', 'exclu')]
    nouveaux_dep = {cle_libelle(r['donnees']['departement']) for r in actifs
                    if r['donnees']['departement_nouveau'] and (r['statut'] == 'nouveau' or 'departement' in r['changements'])}
    nouveaux_grades = {cle_libelle(r['donnees']['grade']) for r in actifs
                       if r['donnees']['grade_nouveau'] and (r['statut'] == 'nouveau' or 'grade' in r['changements'])}
    resume = Counter(r['statut'] for r in resultats)
    reponse = {
        'colonnes': colonnes,
        'mapping': mapping,
        'mapping_suggere': mapping_suggere,
        'champs': SCHEMA.description_champs(),
        'departements': sorted(d.libelle for d in departements),
        'grades': sorted(g.libelle for g in grades),
        'lignes': resultats,
        'resume': {
            'total': len(resultats),
            'nouveaux': resume['nouveau'], 'mises_a_jour': resume['maj'], 'existants': resume['existant'],
            'erreurs': resume['erreur'], 'exclus': resume['exclu'],
            'comptes': sum(1 for r in resultats if r['compte'] == 'a_creer'),
            'departements_nouveaux': len(nouveaux_dep),
            'grades_nouveaux': len(nouveaux_grades),
            'avertissements': sum(1 for r in actifs if r['avertissements']),
        },
    }
    if not valider:
        return reponse, 200

    try:
        bilan = _enregistrer(etablissement_id, resultats, options, dep_par_cle, grade_par_cle, role_enseignant)
    except Exception as exc:  # pragma: no cover - remonté proprement à l'utilisateur
        db.session.rollback()
        return {'erreur': f"L'import a échoué, rien n'a été enregistré : {exc}"}, 500
    reponse['bilan'] = bilan
    return reponse, 200


def _referentiel(modele, cache, libelle, etablissement_id, bilan, cle_bilan):
    cle = cle_libelle(libelle)
    objet = cache.get(cle)
    if objet is None:
        objet = modele(etablissement_id=etablissement_id, libelle=libelle)
        db.session.add(objet)
        db.session.flush()
        cache[cle] = objet
        bilan[cle_bilan] += 1
    return objet


def _enregistrer(etablissement_id, resultats, options, dep_par_cle, grade_par_cle, role_enseignant):
    bilan = Counter()
    identifiants = []
    expiration = datetime.utcnow() + timedelta(hours=TEMP_PASSWORD_VALIDITY_HOURS)

    for r in resultats:
        if r['statut'] in ('erreur', 'exclu'):
            continue
        d = r['donnees']
        if r['enseignant_id'] is None:
            ens = Enseignant(
                etablissement_id=etablissement_id, nom=d['nom'], prenom=d['prenom'], sexe=d['sexe'],
                telephone=d['telephone'] or None, email=d['email'] or None,
                departement_id=_referentiel(Departement, dep_par_cle, d['departement'], etablissement_id, bilan, 'departements_crees').id,
                grade_id=_referentiel(Grade, grade_par_cle, d['grade'], etablissement_id, bilan, 'grades_crees').id,
            )
            db.session.add(ens)
            db.session.flush()
            r['enseignant_id'] = ens.id
            bilan['enseignants_crees'] += 1
        else:
            ens = db.session.get(Enseignant, r['enseignant_id'])
            if r['statut'] == 'maj':
                for champ in r['changements']:
                    if champ == 'departement':
                        ens.departement_id = _referentiel(Departement, dep_par_cle, d['departement'], etablissement_id, bilan, 'departements_crees').id
                    elif champ == 'grade':
                        ens.grade_id = _referentiel(Grade, grade_par_cle, d['grade'], etablissement_id, bilan, 'grades_crees').id
                    else:
                        setattr(ens, champ, d[champ])
                bilan['enseignants_mis_a_jour'] += 1

        if r['compte'] != 'a_creer' or ens.utilisateur_id:
            continue
        compte = None
        if ens.email:
            # Personne ayant déjà un compte dans l'établissement (ex. l'Admin
            # qui enseigne aussi) : on lui ajoute le rôle, sans nouveau PIN.
            compte = Utilisateur.query.filter_by(etablissement_id=etablissement_id, email=ens.email).first()
            if compte and Enseignant.query.filter(Enseignant.utilisateur_id == compte.id).first():
                compte = None
                r['avertissements'].append("Compte de même e-mail déjà relié à un autre enseignant : nouveau compte créé")
        if compte is not None:
            if role_enseignant not in compte.roles:
                compte.roles.append(role_enseignant)
            ens.utilisateur_id = compte.id
            bilan['comptes_relies'] += 1
            continue
        pin = generate_temp_pin()
        compte = Utilisateur(
            nom=f'{ens.prenom} {ens.nom}'.replace('- ', '').strip()[:100],
            email=None if ens.email and Utilisateur.query.filter_by(etablissement_id=etablissement_id, email=ens.email).first() else ens.email,
            roles=[role_enseignant], etablissement_id=etablissement_id, actif=True,
            doit_changer_mdp=True, mdp_expire_le=expiration,
        )
        compte.set_password(pin)
        db.session.add(compte)
        db.session.flush()  # attribue compte.code_connexion
        ens.utilisateur_id = compte.id
        identifiants.append({'nom': compte.nom, 'code': compte.code_connexion, 'pin': pin})
        bilan['comptes_crees'] += 1

    db.session.commit()
    resultat = dict(bilan)
    resultat['identifiants'] = identifiants
    return resultat


def generer_modele_xlsx():
    from services.import_modeles import modele_xlsx
    return modele_xlsx(
        'Enseignants',
        ['Nom', 'Prénom(s)', 'Sexe (M/F)', 'Téléphone', 'E-mail', 'Département', 'Grade'],
        [['ABENG', 'Marie', 'F', '696516429', '', 'Lettres', 'PLEG']],
        largeurs=(22, 26, 11, 16, 28, 22, 14),
        listes={'C': ['M', 'F']},
        aide=[
            "• Une ligne par enseignant. Vous pouvez supprimer la ligne d'exemple.",
            "• Obligatoires : Nom, Prénom(s), Sexe, Département, Grade (département et grade peuvent avoir une valeur par défaut à l'import).",
            "• Les départements et grades absents de l'application sont créés automatiquement.",
            "• Un compte de connexion (code + PIN) peut être créé pour chaque enseignant : la liste des identifiants est fournie à la fin de l'import.",
            "• Vous pouvez aussi importer directement vos anciens fichiers (Excel, CSV, Word), y compris des fiches « NOM : …  GRADE : … ».",
        ],
    )
