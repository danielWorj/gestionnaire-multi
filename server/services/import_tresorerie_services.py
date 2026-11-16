"""Import de masse des opérations de trésorerie (entrées hors scolarité,
dépenses, transferts) depuis les cahiers de caisse et relevés des
établissements (Excel, CSV, Word).

Deux présentations sont comprises :
- « en liste » : Date | Type (entrée / dépense / transfert) | Montant | … ;
- « cahier de caisse » : Date | Libellé | Recettes | Dépenses (le type se
  déduit de la colonne remplie).

Une dépense est prise sur un ou plusieurs fonds (catégories d'entrée) :
colonne « Fonds » au format « Scolarité » ou « Scolarité:40000; APEE:10000 »,
à défaut le fonds choisi en option. Les catégories absentes peuvent être
créées ; les comptes, jamais (ils se créent dans la page Trésorerie).

Les soldes ne sont pas contrôlés : l'import sert justement à reprendre un
historique. Les paiements de scolarité ne s'importent pas ici (ils sont déjà
comptés via le module Paiements) : une ligne qui y ressemble est signalée.
"""

import re
from collections import Counter
from datetime import date
from decimal import Decimal, InvalidOperation

from extensions import db
from models.tresorerie_models import CategorieTresorerie, CompteTresorerie, MouvementTresorerie, VentilationDepense
from services.import_commun import Schema, analyser_avec_schema, cle_libelle, nettoyer_espaces, parser_date, valider_blocs
from services.import_lecture import normaliser
from services.tresorerie_services import CENTIME, initialiser_tresorerie

UTILISE_CONTEXTE = True

CHAMPS = [
    ('date', 'Date', "Date de l'opération"),
    ('type', "Type d'opération", 'Entrée, dépense ou transfert'),
    ('montant', 'Montant', 'Avec une colonne Type'),
    ('entree', 'Montant en entrée (recettes)', 'Cahier de caisse : colonne des recettes'),
    ('sortie', 'Montant en sortie (dépenses)', 'Cahier de caisse : colonne des dépenses'),
    ('libelle', 'Libellé', ''),
    ('categorie', 'Catégorie', "Catégorie d'entrée ou de dépense, créée si besoin"),
    ('fonds', 'Fonds financeur (dépenses)', '« Scolarité » ou « Scolarité:40000; APEE:10000 »'),
    ('compte', 'Compte', 'Caisse, banque, mobile money…'),
    ('compte_destination', 'Compte de destination (transferts)', ''),
    ('tiers', 'Tiers (bénéficiaire ou payeur)', ''),
    ('reference', 'Référence', 'N° de pièce, facture, bordereau…'),
]

SYNONYMES = {
    'numero': ['n', 'no', 'num', 'numero', 'n d ordre', 'ordre', 'n piece'],
    'solde': ['solde', 'solde cumule', 'report', 'cumul'],
    'date': ['date', 'date operation', 'date de l operation', 'jour', 'date piece', 'le'],
    'type': ['type', 'type d operation', 'nature', 'sens', 'operation', 'mouvement', 'nature operation'],
    'montant': ['montant', 'montants', 'somme', 'valeur', 'montant fcfa', 'montant f cfa', 'total'],
    'entree': ['entree', 'entrees', 'recette', 'recettes', 'encaissement', 'encaissements', 'credit', 'credits',
               'montant recu', 'recu'],
    'sortie': ['sortie', 'sorties', 'depense', 'depenses', 'decaissement', 'decaissements', 'debit', 'debits',
               'montant paye', 'paye'],
    'libelle': ['libelle', 'libelles', 'designation', 'objet', 'motif', 'description', 'intitule', 'detail',
                'details', 'operation effectuee', 'nature de la depense'],
    'categorie': ['categorie', 'categories', 'rubrique', 'rubriques', 'poste', 'chapitre', 'imputation',
                  'nature de depense', 'compte comptable', 'ligne budgetaire'],
    'fonds': ['fonds', 'fonds financeur', 'source', 'source de financement', 'financement', 'pris sur',
              'origine des fonds', 'budget'],
    'compte': ['compte', 'caisse', 'compte de tresorerie', 'moyen de paiement', 'mode', 'mode de paiement',
               'reglement', 'mode de reglement'],
    'compte_destination': ['compte de destination', 'destination', 'vers', 'compte destinataire', 'vers le compte'],
    'tiers': ['tiers', 'beneficiaire', 'beneficiaires', 'fournisseur', 'payeur', 'nom', 'client', 'donateur',
              'remis a', 'recu de'],
    'reference': ['reference', 'ref', 'n facture', 'facture', 'piece', 'n de piece', 'bordereau', 'n bordereau',
                  'n cheque', 'cheque', 'justificatif'],
}

TYPES = {
    'ENTREE': ['entree', 'entrees', 'recette', 'recettes', 'encaissement', 'credit', 'recu', 'apport', 'don',
               'subvention', 'e', 'r', '+'],
    'SORTIE': ['sortie', 'sorties', 'depense', 'depenses', 'decaissement', 'debit', 'achat', 'paiement', 'reglement',
               'd', 's', '-'],
    'TRANSFERT': ['transfert', 'virement interne', 'versement en banque', 'depot', 'depot banque', 'retrait',
                  'retrait banque', 't'],
}
MOTS_COMPTE = {
    'CAISSE': ['caisse', 'espece', 'especes', 'cash', 'liquide'],
    'BANQUE': ['banque', 'bque', 'bancaire', 'cheque', 'virement', 'compte bancaire'],
    'MOBILE_MONEY': ['mobile money', 'momo', 'orange money', 'om', 'mtn', 'mtn money', 'mobile'],
}
_SCOLARITE = re.compile(r'scolarit|tranche|inscription|pension|frais exigibles')

LIBELLE_MAX = 255
LIBELLE_CATEGORIE_MAX = 100


def _profil(valeurs):
    vals = [v for v in valeurs if v][:200]
    if not vals:
        return {}
    total = len(vals)
    scores = {}
    # Un nombre seul (« 50000 ») serait lu comme une date Excel : seules les
    # valeurs écrites comme des dates comptent.
    if sum(1 for v in vals if re.search(r'\d[/.\-]\d|[a-z]{3}', normaliser(v)) and parser_date(v)[0]) >= 0.8 * total:
        scores['date'] = 0.7
    if sum(1 for v in vals if _type(v)) >= 0.8 * total:
        scores['type'] = 0.7
    if sum(1 for v in vals if _montant_texte(v) is not None) >= 0.8 * total:
        scores['montant'] = 0.45
    return scores


SCHEMA = Schema(CHAMPS, SYNONYMES, profil=_profil)


def est_tableau_tresorerie(bloc):
    entetes = [normaliser(e) for e in bloc['entetes'] if normaliser(e)]
    a_montant = any(SCHEMA.score(c, e) >= 0.6 for e in entetes for c in ('montant', 'entree', 'sortie'))
    a_contexte = any(SCHEMA.score(c, e) >= 0.6 for e in entetes for c in ('date', 'libelle', 'type'))
    return a_montant and a_contexte


def analyser_fichiers(fichiers, texte_colle=None):
    return analyser_avec_schema(fichiers, texte_colle, SCHEMA, pertinence=est_tableau_tresorerie)


# ---------------------------------------------------------------------------
# Lecture des valeurs
# ---------------------------------------------------------------------------

def _montant_texte(valeur):
    """« 50 000 », « 50.000 FCFA », « 50000,50 », « -1 200 » -> Decimal, ou None."""
    v = (valeur or '').strip()
    if not v:
        return None
    v = re.sub(r'(?i)f\s*cfa|fcfa|xaf|frs?|f\b', '', v)
    v = v.replace(' ', ' ').replace(' ', ' ').strip()
    negatif = v.startswith('-') or (v.startswith('(') and v.endswith(')'))
    v = re.sub(r'[^\d.,]', '', v)
    if not v or not re.search(r'\d', v):
        return None
    if re.fullmatch(r'\d{1,3}([.,]\d{3})+', v):
        v = re.sub(r'[.,]', '', v)                      # séparateurs de milliers
    elif re.fullmatch(r'\d+[.,]\d{1,2}', v):
        v = v.replace(',', '.')                         # décimales
    elif re.fullmatch(r'\d{1,3}(\.\d{3})+,\d{1,2}', v):
        v = v.replace('.', '').replace(',', '.')
    elif re.fullmatch(r'\d{1,3}(,\d{3})+\.\d{1,2}', v):
        v = v.replace(',', '')
    elif not re.fullmatch(r'\d+', v):
        return None
    try:
        m = Decimal(v).quantize(CENTIME)
    except InvalidOperation:
        return None
    return -m if negatif else m


def _type(valeur):
    n = normaliser(valeur)
    if not n:
        return None
    for sens, mots in TYPES.items():
        if n in mots:
            return sens
    for sens, mots in TYPES.items():
        if any(len(m) >= 4 and re.search(rf'(^| ){re.escape(m)}( |$)', n) for m in mots):
            return sens
    return None


def _date(valeur):
    d, alerte = parser_date(valeur)
    if alerte:
        alerte = alerte.replace(' de naissance', '')
    return d, alerte


def _parties_fonds(texte):
    """« Scolarité:40000; APEE:10000 » -> [(libellé, montant | None)]."""
    parties = []
    for morceau in re.split(r'[;/+|\n]', texte or ''):
        morceau = morceau.strip()
        if not morceau:
            continue
        m = re.match(r'^(.*?)\s*[:=]\s*(.+)$', morceau)
        if m and _montant_texte(m.group(2)) is not None:
            parties.append((nettoyer_espaces(m.group(1)), _montant_texte(m.group(2))))
        else:
            parties.append((nettoyer_espaces(morceau), None))
    return parties


# ---------------------------------------------------------------------------
# Traitement
# ---------------------------------------------------------------------------

def _vers_int(valeur):
    try:
        return int(valeur) if valeur not in (None, '') else None
    except (TypeError, ValueError):
        return None


def _options(brutes):
    o = dict(brutes or {})
    return {
        'creer_categories': o.get('creer_categories', True) is not False,
        # Lignes identiques dans les fichiers (même date, sens, montant, compte
        # et libellé) : non importées par défaut, sauf demande explicite.
        'importer_doublons': o.get('importer_doublons') is True,
        'categorie_entree_defaut': nettoyer_espaces(str(o.get('categorie_entree_defaut') or ''))[:LIBELLE_CATEGORIE_MAX],
        'categorie_sortie_defaut': nettoyer_espaces(str(o.get('categorie_sortie_defaut') or ''))[:LIBELLE_CATEGORIE_MAX],
        'fonds_defaut': _vers_int(o.get('fonds_defaut')),
        'compte_defaut': _vers_int(o.get('compte_defaut')),
    }


class _Referentiel:
    """Catégories et comptes de l'établissement, et catégories à créer."""

    def __init__(self, etablissement_id, options):
        self.options = options
        self.categories = CategorieTresorerie.query.filter_by(etablissement_id=etablissement_id).all()
        self.par_cle = {(c.type, cle_libelle(c.libelle)): c for c in self.categories}
        self.comptes = CompteTresorerie.query.filter_by(etablissement_id=etablissement_id, actif=True).all()
        self.compte_par_cle = {cle_libelle(c.libelle): c for c in self.comptes}
        self.defaut_par_type = {c.type: c for c in self.comptes if c.par_defaut}
        self.fonds_par_defaut = next((c for c in self.categories if c.type == 'ENTREE' and c.par_defaut), None)
        self.nouvelles = {}  # (type, clé) -> libellé

    def categorie(self, type_categorie, libelle):
        """-> (catégorie existante | None, libellé, nouvelle, erreur)."""
        cle = cle_libelle(libelle)
        existante = self.par_cle.get((type_categorie, cle))
        if existante:
            if not existante.actif:
                return None, existante.libelle, False, f"La catégorie « {existante.libelle} » est désactivée"
            return existante, existante.libelle, False, None
        nature = "d'entrée" if type_categorie == 'ENTREE' else 'de dépense'
        if not self.options['creer_categories']:
            return None, libelle, False, f"Catégorie {nature} « {libelle} » inconnue"
        if len(libelle) > LIBELLE_CATEGORIE_MAX:
            return None, libelle, False, f"Nom de catégorie trop long ({LIBELLE_CATEGORIE_MAX} caractères maximum)"
        self.nouvelles.setdefault((type_categorie, cle), libelle)
        return None, self.nouvelles[(type_categorie, cle)], True, None

    def compte(self, texte, champ='Compte'):
        """-> (compte | None, erreur)."""
        if not texte:
            choisi = next((c for c in self.comptes if c.id == self.options['compte_defaut']), None)
            return (choisi or self.defaut_par_type.get('CAISSE')), None
        cle = cle_libelle(texte)
        if cle in self.compte_par_cle:
            return self.compte_par_cle[cle], None
        for type_compte, mots in MOTS_COMPTE.items():
            if cle in mots or any(len(m) >= 4 and m in cle for m in mots):
                if type_compte in self.defaut_par_type:
                    return self.defaut_par_type[type_compte], None
        return None, f"{champ} « {texte} » non reconnu (créez-le dans la page Trésorerie ou corrigez la ligne)"


def _lire_ligne(v, ref, avertissements, erreurs):
    """Valeurs brutes -> (sens, montant, date) ; remplit erreurs/avertissements."""
    sens = _type(v.get('type')) if v.get('type') else None
    if v.get('type') and not sens:
        erreurs.append(f"Type d'opération « {v['type']} » non reconnu (entrée, dépense ou transfert)")

    montant = _montant_texte(v.get('montant')) if v.get('montant') else None
    if v.get('montant') and montant is None:
        erreurs.append(f"Montant « {v['montant']} » illisible")
    entree = _montant_texte(v.get('entree')) if v.get('entree') else None
    sortie = _montant_texte(v.get('sortie')) if v.get('sortie') else None
    if v.get('entree') and entree is None:
        erreurs.append(f"Montant en entrée « {v['entree']} » illisible")
    if v.get('sortie') and sortie is None:
        erreurs.append(f"Montant en sortie « {v['sortie']} » illisible")

    if montant is None:
        if entree and sortie:
            erreurs.append("Montant à la fois en entrée et en sortie sur la même ligne")
        elif entree:
            montant, sens = entree, sens or 'ENTREE'
        elif sortie:
            montant, sens = sortie, sens or 'SORTIE'
    if montant is not None and montant < 0:
        montant = -montant
        if not sens:
            sens = 'SORTIE'
    if montant is None and not erreurs:
        erreurs.append("Montant manquant")
    elif montant is not None and montant == 0:
        erreurs.append("Montant nul")
    if montant is not None and not sens and not erreurs:
        erreurs.append("Type d'opération manquant (colonne Type, ou colonnes Recettes / Dépenses)")

    jour, alerte = _date(v.get('date', ''))
    if alerte:
        (erreurs if jour is None else avertissements).append(alerte)
    elif jour is None:
        erreurs.append("Date manquante")
    elif jour > date.today():
        erreurs.append("Date dans le futur")
    return sens, montant, jour


def traiter(etablissement_id, payload, valider=False, contexte=None):
    erreur = valider_blocs(payload)
    if erreur:
        return {'erreur': erreur}, 400
    initialiser_tresorerie(etablissement_id)
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

    ref = _Referentiel(etablissement_id, options)
    existants = {
        (m.sens, m.date_operation, Decimal(m.montant).quantize(CENTIME), m.compte_id, cle_libelle(m.libelle))
        for m in MouvementTresorerie.query.filter_by(etablissement_id=etablissement_id, statut='VALIDE').all()
    }
    vus = {}
    fonds_choisi = next((c for c in ref.categories if c.id == options['fonds_defaut'] and c.type == 'ENTREE'), None)

    resultats = []
    for rid, source, v, _multiples, _bloc in SCHEMA.lignes(blocs, mapping, payload.get('corrections')):
        if not any(v.values()):
            continue
        r = {'id': rid, 'source': source, 'erreurs': [], 'avertissements': [], 'statut': 'nouveau'}
        err, avert = r['erreurs'], r['avertissements']
        sens, montant, jour = _lire_ligne(v, ref, avert, err)

        libelle = nettoyer_espaces(v.get('libelle', '')) or nettoyer_espaces(v.get('categorie', ''))
        if not libelle:
            err.append("Libellé manquant")
        elif len(libelle) > LIBELLE_MAX:
            err.append(f"Libellé trop long ({LIBELLE_MAX} caractères maximum)")

        compte, e = ref.compte(v.get('compte', ''))
        if e:
            err.append(e)
        destination = None
        categorie = {'libelle': '', 'id': None, 'nouvelle': False}
        fonds = []
        if sens == 'TRANSFERT':
            destination, e = ref.compte(v.get('compte_destination', ''), 'Compte de destination') \
                if v.get('compte_destination') else (None, "Compte de destination manquant pour un transfert")
            if e:
                err.append(e)
            elif compte and destination and destination.id == compte.id:
                err.append("Le compte de destination doit être différent du compte de départ")
        elif sens in ('ENTREE', 'SORTIE'):
            texte = nettoyer_espaces(v.get('categorie', '')) or options[
                'categorie_entree_defaut' if sens == 'ENTREE' else 'categorie_sortie_defaut']
            if not texte and sens == 'ENTREE' and ref.fonds_par_defaut:
                texte = ref.fonds_par_defaut.libelle
            if not texte:
                err.append("Catégorie de dépense manquante (colonne Catégorie, ou catégorie par défaut en option)")
            else:
                cat, lib, nouvelle, e = ref.categorie(sens, texte)
                if e:
                    err.append(e)
                categorie = {'libelle': lib, 'id': cat.id if cat else None, 'nouvelle': nouvelle}
            if sens == 'ENTREE' and _SCOLARITE.search(normaliser(f"{libelle} {texte}")):
                avert.append("Ressemble à un paiement de scolarité, déjà compté via le module Paiements : "
                             "excluez la ligne s'il y est enregistré")
            if sens == 'SORTIE' and montant:
                parties = _parties_fonds(v.get('fonds', ''))
                if not parties:
                    defaut = fonds_choisi or ref.fonds_par_defaut
                    parties = [(defaut.libelle, None)] if defaut else []
                if len(parties) == 1 and parties[0][1] is None:
                    parties = [(parties[0][0], montant)]
                if any(m is None for _, m in parties):
                    err.append("Répartition sur plusieurs fonds : indiquez le montant de chacun (« Scolarité:40000; APEE:10000 »)")
                else:
                    for lib_fonds, part in parties:
                        cat, lib, nouvelle, e = ref.categorie('ENTREE', lib_fonds)
                        if e:
                            err.append(e)
                        fonds.append({'libelle': lib, 'id': cat.id if cat else None, 'nouvelle': nouvelle,
                                      'montant': float(part)})
                    if sum(Decimal(str(f['montant'])) for f in fonds) != montant:
                        err.append("La répartition sur les fonds ne correspond pas au montant")
                    if len({cle_libelle(f['libelle']) for f in fonds}) != len(fonds):
                        err.append("Un même fonds apparaît deux fois dans la répartition")

        for valeur, maxi, nom in ((v.get('tiers'), 150, 'Tiers'), (v.get('reference'), 100, 'Référence')):
            if valeur and len(valeur) > maxi:
                err.append(f"{nom} trop long ({maxi} caractères maximum)")

        if not err and compte:
            cle = (sens, jour, montant, compte.id, cle_libelle(libelle))
            if cle in existants:
                r['statut'] = 'existant'
                avert.append("Opération déjà enregistrée (même date, montant, compte et libellé) : ignorée")
            elif cle in vus:
                if options['importer_doublons']:
                    avert.append(f"Ligne identique plus haut ({vus[cle]}) : importée quand même (option choisie)")
                else:
                    r['statut'] = 'doublon'
                    avert.append(f"Doublon de la ligne {vus[cle]} : non importé")
            # Une ligne exclue par l'utilisateur ne compte pas comme première
            # occurrence : sa copie plus bas reste importable.
            if rid not in exclues:
                vus.setdefault(cle, source)

        if rid in exclues:
            r['statut'] = 'exclu'
        elif err:
            r['statut'] = 'erreur'
        r['donnees'] = {
            'date': jour.isoformat() if jour else '', 'sens': sens or '', 'montant': float(montant) if montant else None,
            'libelle': libelle, 'categorie': categorie['libelle'], 'categorie_id': categorie['id'],
            'categorie_nouvelle': categorie['nouvelle'], 'fonds': fonds,
            'compte': compte.libelle if compte else (v.get('compte') or ''), 'compte_id': compte.id if compte else None,
            'compte_destination': destination.libelle if destination else (v.get('compte_destination') or ''),
            'compte_destination_id': destination.id if destination else None,
            'tiers': nettoyer_espaces(v.get('tiers', '')) or None,
            'reference': nettoyer_espaces(v.get('reference', '')) or None,
        }
        resultats.append(r)

    actifs = [r for r in resultats if r['statut'] == 'nouveau']
    utilisees = {(('ENTREE' if r['donnees']['sens'] == 'ENTREE' else 'SORTIE'), cle_libelle(r['donnees']['categorie']))
                 for r in actifs if r['donnees']['categorie_nouvelle']}
    utilisees |= {('ENTREE', cle_libelle(f['libelle'])) for r in actifs for f in r['donnees']['fonds'] if f['nouvelle']}
    statuts = Counter(r['statut'] for r in resultats)
    somme = lambda s: round(sum(r['donnees']['montant'] or 0 for r in actifs if r['donnees']['sens'] == s), 2)  # noqa: E731

    reponse = {
        'colonnes': colonnes,
        'mapping': mapping,
        'mapping_suggere': mapping_suggere,
        'champs': SCHEMA.description_champs(),
        'categories_entree': sorted(c.libelle for c in ref.categories if c.type == 'ENTREE' and c.actif),
        'categories_sortie': sorted(c.libelle for c in ref.categories if c.type == 'SORTIE' and c.actif),
        'fonds': [{'id': c.id, 'libelle': c.libelle} for c in ref.categories if c.type == 'ENTREE' and c.actif],
        'comptes': [{'id': c.id, 'libelle': c.libelle} for c in ref.comptes],
        'lignes': resultats,
        'resume': {
            'total': len(resultats), 'nouveaux': statuts['nouveau'], 'mises_a_jour': 0,
            'existants': statuts['existant'], 'erreurs': statuts['erreur'], 'exclus': statuts['exclu'],
            'doublons': statuts['doublon'],
            'avertissements': sum(1 for r in resultats if r['avertissements'] and r['statut'] not in ('erreur', 'exclu', 'doublon')),
            'categories_nouvelles': len(utilisees),
            'total_entrees': somme('ENTREE'), 'total_sorties': somme('SORTIE'), 'total_transferts': somme('TRANSFERT'),
        },
    }
    if not valider:
        return reponse, 200

    contexte = contexte or {}
    if contexte.get('role') == 'SuperAdmin':
        return {'erreur': "Le SuperAdmin ne peut pas enregistrer d'opérations de trésorerie : "
                          "connectez-vous avec un compte Comptable ou Admin de l'établissement"}, 403
    try:
        reponse['bilan'] = _enregistrer(etablissement_id, actifs, ref, contexte.get('user_id'))
    except Exception as exc:  # pragma: no cover - remonté proprement à l'utilisateur
        db.session.rollback()
        return {'erreur': f"L'import a échoué, rien n'a été enregistré : {exc}"}, 500
    return reponse, 200


def _enregistrer(etablissement_id, lignes, ref, saisi_par_id):
    bilan = Counter()
    creees = {}

    def categorie_id(type_categorie, existant_id, libelle):
        if existant_id:
            return existant_id
        cle = (type_categorie, cle_libelle(libelle))
        if cle not in creees:
            c = CategorieTresorerie(etablissement_id=etablissement_id, type=type_categorie, libelle=libelle,
                                    par_defaut=False, actif=True)
            db.session.add(c)
            db.session.flush()
            creees[cle] = c.id
            bilan['categories_creees'] += 1
        return creees[cle]

    for r in lignes:
        d = r['donnees']
        sens = d['sens']
        m = MouvementTresorerie(
            etablissement_id=etablissement_id, sens=sens, date_operation=date.fromisoformat(d['date']),
            montant=Decimal(str(d['montant'])).quantize(CENTIME), libelle=d['libelle'],
            categorie_id=None if sens == 'TRANSFERT' else categorie_id(sens, d['categorie_id'], d['categorie']),
            compte_id=d['compte_id'], compte_destination_id=d['compte_destination_id'] if sens == 'TRANSFERT' else None,
            tiers=d['tiers'], reference=d['reference'], statut='VALIDE', saisi_par_id=saisi_par_id,
        )
        db.session.add(m)
        db.session.flush()
        for f in d['fonds'] if sens == 'SORTIE' else []:
            db.session.add(VentilationDepense(
                mouvement_id=m.id, categorie_entree_id=categorie_id('ENTREE', f['id'], f['libelle']),
                montant=Decimal(str(f['montant'])).quantize(CENTIME)))
        bilan[{'ENTREE': 'entrees_creees', 'SORTIE': 'depenses_creees', 'TRANSFERT': 'transferts_crees'}[sens]] += 1
    db.session.commit()
    return dict(bilan)


def generer_modele_xlsx():
    from services.import_modeles import modele_xlsx
    return modele_xlsx(
        'Trésorerie',
        ['Date', 'Type', 'Montant', 'Libellé', 'Catégorie', 'Fonds', 'Compte', 'Compte de destination', 'Tiers', 'Référence'],
        [['03/10/2026', 'Dépense', 50000, 'Vacations octobre', 'Salaires vacataires', 'Scolarité:40000; APEE:10000', 'Caisse', '', 'M. Ndzana', 'PC-0012'],
         ['05/10/2026', 'Entrée', 200000, 'Subvention communale', 'Subventions', '', 'Banque', '', 'Mairie', 'VIR-889'],
         ['06/10/2026', 'Transfert', 150000, 'Dépôt des espèces', '', '', 'Caisse', 'Banque', '', 'BRD-41']],
        largeurs=(12, 11, 12, 30, 22, 30, 14, 20, 18, 12),
        listes={'B': ['Entrée', 'Dépense', 'Transfert']},
        aide=[
            "• Une ligne par opération. Type : Entrée, Dépense ou Transfert (ou deux colonnes Recettes / Dépenses à la place de Type et Montant).",
            "• Catégorie : catégorie d'entrée (fonds) pour une entrée, catégorie de dépense pour une dépense. Les catégories absentes sont créées.",
            "• Fonds (dépenses seulement) : le fonds qui paie la dépense, ou plusieurs avec leur part : « Scolarité:40000; APEE:10000 ». Vide : fonds choisi à l'import.",
            "• Compte : nom d'un compte de la page Trésorerie, ou simplement Caisse, Banque, Mobile Money. Vide : compte choisi à l'import.",
            "• N'importez pas les paiements de scolarité : ils sont déjà comptés via le module Paiements.",
            "• Pour reprendre l'argent déjà en caisse au démarrage, ajoutez une entrée « Report de solde » par fonds.",
        ],
    )
