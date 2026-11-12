"""Trésorerie : catégories (entrées = fonds, sorties), comptes, mouvements
saisis à la main, et états (journal, synthèse par catégorie, soldes des fonds
et des comptes).

Les paiements de scolarité VALIDE sont des entrées lues directement dans
paiements_models (jamais recopiées) :
  - fonds   : TrancheClasse.categorie_entree_id, à défaut la catégorie
              d'entrée par défaut de l'établissement ;
  - compte  : le compte par défaut du type associé au mode de paiement
              (COMPTE_PAR_MODE).
Un paiement annulé cesse donc immédiatement de compter, ici comme ailleurs.

Soldes (jamais stockés, recalculés à chaque appel) :
  solde d'un fonds  = entrées du fonds (scolarité + entrées manuelles)
                      − parts de dépenses imputées sur ce fonds
  solde d'un compte = entrées sur le compte − sorties − transferts sortants
                      + transferts entrants
  La somme des soldes des fonds est égale à la somme des soldes des comptes
  (un transfert ne change que la répartition entre comptes).
"""
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from flask import current_app
from sqlalchemy.exc import IntegrityError

from extensions import db
from services.conflits_services import extraire_controle, reponse_conflit
from models.inscription_models import Eleve, Inscription
from models.paiements_models import LignePaiement, Paiement, TrancheClasse
from models.structure_models import Classe
from models.tresorerie_models import (
    SENS_MOUVEMENT, TYPES_CATEGORIE, TYPES_COMPTE,
    CategorieTresorerie, CompteTresorerie, MouvementTresorerie, VentilationDepense,
)

COMPTE_PAR_MODE = {'ESPECES': 'CAISSE', 'MOBILE_MONEY': 'MOBILE_MONEY', 'VIREMENT': 'BANQUE', 'CHEQUE': 'BANQUE'}
CATEGORIE_DEFAUT = 'Scolarité'
COMPTES_DEFAUT = {'CAISSE': 'Caisse', 'BANQUE': 'Banque', 'MOBILE_MONEY': 'Mobile Money'}

LIBELLE_MAX = 255
LIBELLE_REFERENTIEL_MAX = 100
TIERS_MAX = 150
REFERENCE_MAX = 100
MOTIF_MAX = 255
CENTIME = Decimal('0.01')


# ---------------------------------------------------------------------------
# Outils
# ---------------------------------------------------------------------------

def _montant(valeur, champ='montant'):
    """(Decimal, None) ou (None, message) : montant strictement positif."""
    try:
        m = Decimal(str(valeur)).quantize(CENTIME)
    except (InvalidOperation, TypeError, ValueError):
        return None, f"{champ} invalide"
    if m <= 0:
        return None, f"{champ} doit être strictement positif"
    return m, None


def _texte(valeur):
    return str(valeur).strip() if valeur is not None else ''


def parse_date(valeur, champ):
    """(date|None, message|None) : '' et None donnent (None, None)."""
    if valeur in (None, ''):
        return None, None
    if isinstance(valeur, date):
        return valeur, None
    try:
        return datetime.strptime(str(valeur)[:10], '%Y-%m-%d').date(), None
    except ValueError:
        return None, f"{champ} invalide (format attendu : AAAA-MM-JJ)"


def debut_annee_scolaire(jour=None):
    """1er septembre de l'année scolaire en cours (période par défaut)."""
    jour = jour or date.today()
    return date(jour.year if jour.month >= 9 else jour.year - 1, 9, 1)


def _f(valeur):
    return float(valeur or 0)


def _commit(message_conflit):
    try:
        db.session.commit()
        return None
    except IntegrityError as e:
        db.session.rollback()
        current_app.logger.error("IntegrityError trésorerie : %s", getattr(e, 'orig', e))
        return {"erreur": message_conflit}, 409
    except Exception:
        db.session.rollback()
        current_app.logger.exception("Erreur trésorerie")
        return {"erreur": "Erreur lors de l'enregistrement"}, 500


# ---------------------------------------------------------------------------
# Initialisation : catégorie par défaut et comptes par défaut
# ---------------------------------------------------------------------------

def initialiser_tresorerie(etablissement_id):
    """Crée, s'ils manquent, la catégorie d'entrée par défaut (« Scolarité »)
    et un compte par défaut de chaque type. Idempotent."""
    cree = False
    if not CategorieTresorerie.query.filter_by(etablissement_id=etablissement_id, type='ENTREE',
                                               par_defaut=True).first():
        existante = CategorieTresorerie.query.filter_by(etablissement_id=etablissement_id, type='ENTREE',
                                                        libelle=CATEGORIE_DEFAUT).first()
        if existante:
            existante.par_defaut, existante.actif = True, True
        else:
            db.session.add(CategorieTresorerie(etablissement_id=etablissement_id, type='ENTREE',
                                               libelle=CATEGORIE_DEFAUT, par_defaut=True))
        cree = True
    for type_compte, libelle in COMPTES_DEFAUT.items():
        if CompteTresorerie.query.filter_by(etablissement_id=etablissement_id, type=type_compte,
                                            par_defaut=True).first():
            continue
        existant = CompteTresorerie.query.filter_by(etablissement_id=etablissement_id, type=type_compte,
                                                    actif=True).order_by(CompteTresorerie.id).first()
        if existant:
            existant.par_defaut = True
        else:
            libre = libelle
            n = 2
            while CompteTresorerie.query.filter_by(etablissement_id=etablissement_id, libelle=libre).first():
                libre, n = f"{libelle} {n}", n + 1
            db.session.add(CompteTresorerie(etablissement_id=etablissement_id, type=type_compte,
                                            libelle=libre, par_defaut=True))
        cree = True
    if cree:
        db.session.commit()


def categorie_defaut_id(etablissement_id):
    return db.session.query(CategorieTresorerie.id).filter_by(
        etablissement_id=etablissement_id, type='ENTREE', par_defaut=True).scalar()


def comptes_defaut(etablissement_id):
    """{type de compte: compte_id par défaut}."""
    return {t: i for i, t in db.session.query(CompteTresorerie.id, CompteTresorerie.type)
            .filter_by(etablissement_id=etablissement_id, par_defaut=True).all()}


def compte_de_mode(mode_paiement, defauts):
    return defauts.get(COMPTE_PAR_MODE.get(mode_paiement, 'CAISSE'))


# ---------------------------------------------------------------------------
# Catégories
# ---------------------------------------------------------------------------

def get_categories(etablissement_id, type_categorie=None):
    initialiser_tresorerie(etablissement_id)
    q = CategorieTresorerie.query.filter_by(etablissement_id=etablissement_id)
    if type_categorie:
        q = q.filter_by(type=type_categorie)
    return [c.to_dict() for c in q.order_by(CategorieTresorerie.type, CategorieTresorerie.par_defaut.desc(),
                                            CategorieTresorerie.libelle).all()]


def get_categorie(categorie_id, etablissement_id):
    c = db.session.get(CategorieTresorerie, categorie_id)
    return c if c and c.etablissement_id == etablissement_id else None


def create_categorie(data, etablissement_id):
    data = data or {}
    type_categorie = data.get('type')
    if type_categorie not in TYPES_CATEGORIE:
        return {"erreur": "type invalide (ENTREE ou SORTIE)"}, 400
    libelle = _texte(data.get('libelle'))
    if not libelle:
        return {"erreur": "libelle requis"}, 400
    if len(libelle) > LIBELLE_REFERENTIEL_MAX:
        return {"erreur": f"libelle trop long ({LIBELLE_REFERENTIEL_MAX} caractères maximum)"}, 400
    categorie = CategorieTresorerie(etablissement_id=etablissement_id, type=type_categorie, libelle=libelle,
                                    par_defaut=False, actif=True)
    db.session.add(categorie)
    erreur = _commit("Une catégorie de ce nom existe déjà")
    return erreur or (categorie.to_dict(), 201)


def update_categorie(categorie, data):
    data = data or {}
    if 'libelle' in data:
        libelle = _texte(data['libelle'])
        if not libelle:
            return {"erreur": "libelle requis"}, 400
        if len(libelle) > LIBELLE_REFERENTIEL_MAX:
            return {"erreur": f"libelle trop long ({LIBELLE_REFERENTIEL_MAX} caractères maximum)"}, 400
        categorie.libelle = libelle
    if 'actif' in data:
        actif = bool(data['actif'])
        if not actif and categorie.par_defaut:
            return {"erreur": "La catégorie par défaut ne peut pas être désactivée"}, 400
        categorie.actif = actif
    erreur = _commit("Une catégorie de ce nom existe déjà")
    return erreur or (categorie.to_dict(), 200)


def _categorie_utilisee(categorie_id):
    return bool(
        MouvementTresorerie.query.filter_by(categorie_id=categorie_id).first()
        or VentilationDepense.query.filter_by(categorie_entree_id=categorie_id).first()
        or TrancheClasse.query.filter_by(categorie_entree_id=categorie_id).first()
    )


def delete_categorie(categorie):
    if categorie.par_defaut:
        return {"erreur": "La catégorie par défaut ne peut pas être supprimée"}, 400
    if _categorie_utilisee(categorie.id):
        return {"erreur": "Cette catégorie est déjà utilisée (opérations ou tranches) : "
                          "désactivez-la plutôt que de la supprimer"}, 400
    db.session.delete(categorie)
    erreur = _commit("Suppression impossible")
    return erreur or ({"message": "Supprimé avec succès"}, 200)


# ---------------------------------------------------------------------------
# Comptes
# ---------------------------------------------------------------------------

def get_comptes(etablissement_id):
    initialiser_tresorerie(etablissement_id)
    return [c.to_dict() for c in CompteTresorerie.query.filter_by(etablissement_id=etablissement_id)
            .order_by(CompteTresorerie.type, CompteTresorerie.par_defaut.desc(), CompteTresorerie.libelle).all()]


def get_compte(compte_id, etablissement_id):
    c = db.session.get(CompteTresorerie, compte_id)
    return c if c and c.etablissement_id == etablissement_id else None


def _rendre_defaut(compte):
    CompteTresorerie.query.filter(
        CompteTresorerie.etablissement_id == compte.etablissement_id,
        CompteTresorerie.type == compte.type,
        CompteTresorerie.id != compte.id,
    ).update({'par_defaut': False}, synchronize_session='fetch')
    compte.par_defaut = True
    compte.actif = True


def create_compte(data, etablissement_id):
    data = data or {}
    type_compte = data.get('type')
    if type_compte not in TYPES_COMPTE:
        return {"erreur": "type invalide (CAISSE, BANQUE ou MOBILE_MONEY)"}, 400
    libelle = _texte(data.get('libelle'))
    if not libelle:
        return {"erreur": "libelle requis"}, 400
    if len(libelle) > LIBELLE_REFERENTIEL_MAX:
        return {"erreur": f"libelle trop long ({LIBELLE_REFERENTIEL_MAX} caractères maximum)"}, 400
    compte = CompteTresorerie(etablissement_id=etablissement_id, type=type_compte, libelle=libelle,
                              par_defaut=False, actif=True)
    db.session.add(compte)
    db.session.flush()
    if data.get('par_defaut'):
        _rendre_defaut(compte)
    erreur = _commit("Un compte de ce nom existe déjà")
    return erreur or (compte.to_dict(), 201)


def update_compte(compte, data):
    data = data or {}
    if 'libelle' in data:
        libelle = _texte(data['libelle'])
        if not libelle:
            return {"erreur": "libelle requis"}, 400
        if len(libelle) > LIBELLE_REFERENTIEL_MAX:
            return {"erreur": f"libelle trop long ({LIBELLE_REFERENTIEL_MAX} caractères maximum)"}, 400
        compte.libelle = libelle
    if 'actif' in data:
        actif = bool(data['actif'])
        if not actif and compte.par_defaut:
            return {"erreur": "Le compte par défaut ne peut pas être désactivé : "
                              "désignez d'abord un autre compte par défaut pour ce type"}, 400
        compte.actif = actif
    if data.get('par_defaut') and not compte.par_defaut:
        _rendre_defaut(compte)
    erreur = _commit("Un compte de ce nom existe déjà")
    return erreur or (compte.to_dict(), 200)


def delete_compte(compte):
    if compte.par_defaut:
        return {"erreur": "Le compte par défaut ne peut pas être supprimé"}, 400
    utilise = MouvementTresorerie.query.filter(
        (MouvementTresorerie.compte_id == compte.id) | (MouvementTresorerie.compte_destination_id == compte.id)
    ).first()
    if utilise:
        return {"erreur": "Ce compte a déjà des opérations : désactivez-le plutôt que de le supprimer"}, 400
    db.session.delete(compte)
    erreur = _commit("Suppression impossible")
    return erreur or ({"message": "Supprimé avec succès"}, 200)


# ---------------------------------------------------------------------------
# Soldes
# ---------------------------------------------------------------------------

def _bornes(du, au):
    """Bornes datetime [du, au+1j[ pour Paiement.date_paiement (DateTime)."""
    debut = datetime.combine(du, datetime.min.time()) if du else None
    fin = datetime.combine(au + timedelta(days=1), datetime.min.time()) if au else None
    return debut, fin


def _filtre_paiement(q, etablissement_id, du=None, au=None):
    debut, fin = _bornes(du, au)
    q = (q.join(Inscription, Paiement.inscription_id == Inscription.id)
         .join(Classe, Inscription.classe_id == Classe.id)
         .filter(Classe.etablissement_id == etablissement_id, Paiement.statut == 'VALIDE'))
    if debut:
        q = q.filter(Paiement.date_paiement >= debut)
    if fin:
        q = q.filter(Paiement.date_paiement < fin)
    return q


def _filtre_mouvement(q, etablissement_id, du=None, au=None):
    q = q.filter(MouvementTresorerie.etablissement_id == etablissement_id, MouvementTresorerie.statut == 'VALIDE')
    if du:
        q = q.filter(MouvementTresorerie.date_operation >= du)
    if au:
        q = q.filter(MouvementTresorerie.date_operation <= au)
    return q


def _scolarite_par_fonds(etablissement_id, du=None, au=None):
    """{categorie_entree_id: montant} des paiements de scolarité VALIDE."""
    defaut = categorie_defaut_id(etablissement_id)
    q = (db.session.query(TrancheClasse.categorie_entree_id, db.func.sum(LignePaiement.montant_verse))
         .select_from(LignePaiement)
         .join(Paiement, LignePaiement.paiement_id == Paiement.id)
         .join(TrancheClasse, LignePaiement.tranche_classe_id == TrancheClasse.id))
    q = _filtre_paiement(q, etablissement_id, du, au).group_by(TrancheClasse.categorie_entree_id)
    resultat = {}
    for categorie_id, montant in q.all():
        cle = categorie_id or defaut
        resultat[cle] = resultat.get(cle, 0.0) + _f(montant)
    return resultat


def _par_categorie(sens, etablissement_id, du=None, au=None):
    q = (db.session.query(MouvementTresorerie.categorie_id, db.func.sum(MouvementTresorerie.montant))
         .filter(MouvementTresorerie.sens == sens))
    return {c: _f(m) for c, m in _filtre_mouvement(q, etablissement_id, du, au)
            .group_by(MouvementTresorerie.categorie_id).all()}


def _depenses_par_fonds(etablissement_id, du=None, au=None):
    q = (db.session.query(VentilationDepense.categorie_entree_id, db.func.sum(VentilationDepense.montant))
         .join(MouvementTresorerie, VentilationDepense.mouvement_id == MouvementTresorerie.id))
    return {c: _f(m) for c, m in _filtre_mouvement(q, etablissement_id, du, au)
            .group_by(VentilationDepense.categorie_entree_id).all()}


def soldes_fonds(etablissement_id, au=None):
    """{categorie_entree_id: {entrees, depenses, solde}}, cumulés jusqu'à `au`."""
    scolarite = _scolarite_par_fonds(etablissement_id, None, au)
    manuelles = _par_categorie('ENTREE', etablissement_id, None, au)
    depenses = _depenses_par_fonds(etablissement_id, None, au)
    resultat = {}
    for cid in set(scolarite) | set(manuelles) | set(depenses):
        entrees = scolarite.get(cid, 0.0) + manuelles.get(cid, 0.0)
        resultat[cid] = {'entrees': round(entrees, 2), 'depenses': round(depenses.get(cid, 0.0), 2),
                         'solde': round(entrees - depenses.get(cid, 0.0), 2)}
    return resultat


def soldes_comptes(etablissement_id, au=None):
    """{compte_id: solde}, cumulés jusqu'à `au`."""
    defauts = comptes_defaut(etablissement_id)
    soldes = {}

    def ajouter(compte_id, montant):
        if compte_id is not None:
            soldes[compte_id] = soldes.get(compte_id, 0.0) + montant

    q = db.session.query(Paiement.mode_paiement, db.func.sum(Paiement.montant_total))
    for mode, montant in _filtre_paiement(q, etablissement_id, None, au).group_by(Paiement.mode_paiement).all():
        ajouter(compte_de_mode(mode, defauts), _f(montant))

    q = db.session.query(MouvementTresorerie.sens, MouvementTresorerie.compte_id,
                         MouvementTresorerie.compte_destination_id, db.func.sum(MouvementTresorerie.montant))
    q = _filtre_mouvement(q, etablissement_id, None, au).group_by(
        MouvementTresorerie.sens, MouvementTresorerie.compte_id, MouvementTresorerie.compte_destination_id)
    for sens, compte_id, destination_id, montant in q.all():
        montant = _f(montant)
        if sens == 'ENTREE':
            ajouter(compte_id, montant)
        else:
            ajouter(compte_id, -montant)
            if sens == 'TRANSFERT':
                ajouter(destination_id, montant)
    return {k: round(v, 2) for k, v in soldes.items()}


# ---------------------------------------------------------------------------
# Mouvements
# ---------------------------------------------------------------------------

def get_mouvement(mouvement_id, etablissement_id):
    m = db.session.get(MouvementTresorerie, mouvement_id)
    return m if m and m.etablissement_id == etablissement_id else None


def _categorie_active(categorie_id, etablissement_id, type_attendu, champ):
    if categorie_id in (None, ''):
        return None, f"{champ} requis"
    try:
        categorie = db.session.get(CategorieTresorerie, int(categorie_id))
    except (TypeError, ValueError):
        categorie = None
    if not categorie or categorie.etablissement_id != etablissement_id or categorie.type != type_attendu:
        libelle = "d'entrée" if type_attendu == 'ENTREE' else 'de sortie'
        return None, f"Catégorie {libelle} invalide pour cet établissement ({champ})"
    if not categorie.actif:
        return None, f"La catégorie « {categorie.libelle} » est désactivée"
    return categorie, None


def _compte_actif(compte_id, etablissement_id, champ):
    if compte_id in (None, ''):
        return None, f"{champ} requis"
    try:
        compte = db.session.get(CompteTresorerie, int(compte_id))
    except (TypeError, ValueError):
        compte = None
    if not compte or compte.etablissement_id != etablissement_id:
        return None, f"Compte invalide pour cet établissement ({champ})"
    if not compte.actif:
        return None, f"Le compte « {compte.libelle} » est désactivé"
    return compte, None


def _valider_ventilation(data, montant, etablissement_id):
    """Liste [(categorie, Decimal)] dont la somme vaut `montant`. Accepte
    `ventilation: [{categorie_id, montant}]` ou, pour une dépense prise sur
    un seul fonds, `categorie_entree_id`."""
    brute = data.get('ventilation')
    if not brute and data.get('categorie_entree_id') not in (None, ''):
        brute = [{'categorie_id': data['categorie_entree_id'], 'montant': str(montant)}]
    if not brute:
        return None, "Indiquez le ou les fonds (catégories d'entrée) sur lesquels la dépense est prise"
    vus, parts, somme = set(), [], Decimal('0')
    for ligne in brute:
        categorie, erreur = _categorie_active((ligne or {}).get('categorie_id'), etablissement_id, 'ENTREE',
                                              'ventilation.categorie_id')
        if erreur:
            return None, erreur
        if categorie.id in vus:
            return None, f"Le fonds « {categorie.libelle} » apparaît deux fois dans la ventilation"
        vus.add(categorie.id)
        part, erreur = _montant(ligne.get('montant'), 'ventilation.montant')
        if erreur:
            return None, erreur
        parts.append((categorie, part))
        somme += part
    if somme != montant:
        return None, (f"La répartition sur les fonds ({float(somme):.0f}) ne correspond pas "
                      f"au montant de la dépense ({float(montant):.0f})")
    return parts, None


def _avertissements_solde(etablissement_id, compte, montant, parts):
    """Fonds ou compte dont le solde actuel ne couvre pas la sortie."""
    avertissements = []
    if parts:
        fonds = soldes_fonds(etablissement_id)
        for categorie, part in parts:
            disponible = fonds.get(categorie.id, {}).get('solde', 0.0)
            if float(part) > disponible:
                avertissements.append({'type': 'fonds', 'id': categorie.id, 'libelle': categorie.libelle,
                                       'disponible': disponible, 'demande': float(part)})
    disponible = soldes_comptes(etablissement_id).get(compte.id, 0.0)
    if float(montant) > disponible:
        avertissements.append({'type': 'compte', 'id': compte.id, 'libelle': compte.libelle,
                               'disponible': disponible, 'demande': float(montant)})
    return avertissements


def create_mouvement(data, etablissement_id, saisi_par_id):
    """Payload : {sens, date_operation?, montant, libelle, compte_id,
    categorie_id (ENTREE/SORTIE), ventilation | categorie_entree_id (SORTIE),
    compte_destination_id (TRANSFERT), tiers?, reference?, forcer?}.

    Une sortie ou un transfert qui dépasse le solde d'un fonds ou du compte
    n'est pas refusé d'office : réponse 409 code 'solde_insuffisant' avec le
    détail, l'utilisateur confirme en renvoyant la saisie avec forcer=true
    (le solde peut être faux tant que l'historique n'est pas complet)."""
    data = dict(data or {})
    controle = extraire_controle(data)
    forcer = controle.forcer
    initialiser_tresorerie(etablissement_id)

    # Renvoi d'une opération déjà enregistrée (saisie hors connexion dont la
    # réponse s'est perdue) : on renvoie l'existante, jamais un doublon.
    cle_idempotence = _texte(data.get('cle_idempotence'))[:40] or None
    if cle_idempotence:
        deja = MouvementTresorerie.query.filter_by(cle_idempotence=cle_idempotence).first()
        if deja:
            if deja.etablissement_id != etablissement_id:
                return {"erreur": "Accès non autorisé à cette ressource"}, 403
            return deja.to_dict(), 200

    sens = data.get('sens')
    if sens not in SENS_MOUVEMENT:
        return {"erreur": "sens invalide (ENTREE, SORTIE ou TRANSFERT)"}, 400

    date_operation, erreur = parse_date(data.get('date_operation'), 'date_operation')
    if erreur:
        return {"erreur": erreur}, 400
    date_operation = date_operation or date.today()
    if date_operation > date.today():
        return {"erreur": "La date de l'opération ne peut pas être dans le futur"}, 400

    montant, erreur = _montant(data.get('montant'))
    if erreur:
        return {"erreur": erreur}, 400

    libelle = _texte(data.get('libelle'))
    if not libelle:
        return {"erreur": "libelle requis"}, 400
    tiers = _texte(data.get('tiers')) or None
    reference = _texte(data.get('reference')) or None
    for valeur, maxi, champ in ((libelle, LIBELLE_MAX, 'libelle'), (tiers, TIERS_MAX, 'tiers'),
                                (reference, REFERENCE_MAX, 'reference')):
        if valeur and len(valeur) > maxi:
            return {"erreur": f"{champ} trop long ({maxi} caractères maximum)"}, 400

    compte, erreur = _compte_actif(data.get('compte_id'), etablissement_id, 'compte_id')
    if erreur:
        return {"erreur": erreur}, 400

    categorie, destination, parts = None, None, []
    if sens == 'TRANSFERT':
        destination, erreur = _compte_actif(data.get('compte_destination_id'), etablissement_id,
                                            'compte_destination_id')
        if erreur:
            return {"erreur": erreur}, 400
        if destination.id == compte.id:
            return {"erreur": "Le compte de destination doit être différent du compte de départ"}, 400
    else:
        categorie, erreur = _categorie_active(data.get('categorie_id'), etablissement_id, sens, 'categorie_id')
        if erreur:
            return {"erreur": erreur}, 400
        if sens == 'SORTIE':
            parts, erreur = _valider_ventilation(data, montant, etablissement_id)
            if erreur:
                return {"erreur": erreur}, 400

    # Doublon probable (même type, même montant, même jour, même compte et
    # même catégorie, déjà enregistré) : l'utilisateur confirme ou renonce —
    # même protocole que les paiements (client qui envoie version_base).
    if controle.fourni and not forcer:
        probable = MouvementTresorerie.query.filter_by(
            etablissement_id=etablissement_id, sens=sens, montant=montant, date_operation=date_operation,
            compte_id=compte.id, categorie_id=categorie.id if categorie else None, statut='VALIDE',
        ).order_by(MouvementTresorerie.id.desc()).first()
        if probable:
            return reponse_conflit(probable, 'doublon',
                                   "Une opération identique (même montant, même jour, même compte) est déjà enregistrée.")

    if sens != 'ENTREE' and not forcer:
        avertissements = _avertissements_solde(etablissement_id, compte, montant, parts)
        if avertissements:
            noms = ', '.join(f"« {a['libelle']} »" for a in avertissements)
            return {"erreur": f"Solde insuffisant : {noms}. Enregistrer quand même ?",
                    "code": "solde_insuffisant", "avertissements": avertissements}, 409

    mouvement = MouvementTresorerie(
        etablissement_id=etablissement_id, sens=sens, date_operation=date_operation, montant=montant,
        libelle=libelle, categorie_id=categorie.id if categorie else None, compte_id=compte.id,
        compte_destination_id=destination.id if destination else None, tiers=tiers, reference=reference,
        statut='VALIDE', saisi_par_id=saisi_par_id, cle_idempotence=cle_idempotence,
    )
    db.session.add(mouvement)
    db.session.flush()
    for cat, part in parts:
        db.session.add(VentilationDepense(mouvement_id=mouvement.id, categorie_entree_id=cat.id, montant=part))
    erreur = _commit("Enregistrement impossible (contrainte non respectée)")
    return erreur or (mouvement.to_dict(), 201)


def update_mouvement(mouvement, data):
    """Seuls libelle, tiers et reference se corrigent ; pour le reste
    (montant, date, catégorie, compte, fonds), annuler puis ressaisir."""
    if mouvement.statut != 'VALIDE':
        return {"erreur": "Cette opération est annulée : elle n'est plus modifiable"}, 400
    data = data or {}
    modifie = False
    for champ, maxi, requis in (('libelle', LIBELLE_MAX, True), ('tiers', TIERS_MAX, False),
                                ('reference', REFERENCE_MAX, False)):
        if champ not in data:
            continue
        valeur = _texte(data[champ]) or None
        if requis and not valeur:
            return {"erreur": f"{champ} requis"}, 400
        if valeur and len(valeur) > maxi:
            return {"erreur": f"{champ} trop long ({maxi} caractères maximum)"}, 400
        setattr(mouvement, champ, valeur)
        modifie = True
    if not modifie:
        return {"erreur": "Aucun champ modifiable fourni (libelle, tiers, reference). "
                          "Pour le reste, annulez l'opération puis ressaisissez-la."}, 400
    erreur = _commit("Enregistrement impossible")
    return erreur or (mouvement.to_dict(), 200)


def annuler_mouvement(mouvement, motif):
    motif = _texte(motif)
    if not motif:
        return {"erreur": "motif_annulation requis"}, 400
    # Déjà annulée : réponse identique (annulation saisie hors connexion et
    # rejouée, ou faite entre-temps sur un autre poste) — le motif d'origine
    # est conservé.
    if mouvement.statut == 'ANNULE':
        return mouvement.to_dict(), 200
    if len(motif) > MOTIF_MAX:
        return {"erreur": f"motif_annulation trop long ({MOTIF_MAX} caractères maximum)"}, 400
    mouvement.statut, mouvement.motif_annulation = 'ANNULE', motif
    erreur = _commit("Annulation impossible")
    return erreur or (mouvement.to_dict(), 200)


# ---------------------------------------------------------------------------
# États
# ---------------------------------------------------------------------------

def _periode(du, au):
    """(du, au, erreur) avec valeurs par défaut : début de l'année scolaire
    en cours → aujourd'hui."""
    du, erreur = parse_date(du, 'du')
    if erreur:
        return None, None, erreur
    au, erreur = parse_date(au, 'au')
    if erreur:
        return None, None, erreur
    au = au or date.today()
    du = du or debut_annee_scolaire(au)
    if du > au:
        return None, None, "La date de début doit précéder la date de fin"
    return du, au, None


def get_journal(etablissement_id, du=None, au=None, sens=None, categorie_id=None, compte_id=None,
                avec_annules=True):
    """Toutes les opérations de la période, la plus récente d'abord :
    paiements de scolarité VALIDE (origine 'paiement') et mouvements saisis
    (origine 'mouvement', annulés compris si avec_annules, signalés par
    statut). `ventilation` donne, pour une entrée, sa répartition par fonds
    et, pour une dépense, les fonds qui la financent."""
    du, au, erreur = _periode(du, au)
    if erreur:
        return {"erreur": erreur}, 400
    initialiser_tresorerie(etablissement_id)
    defaut = categorie_defaut_id(etablissement_id)
    defauts = comptes_defaut(etablissement_id)
    lignes = []

    # Paiements de scolarité
    q = _filtre_paiement(db.session.query(Paiement, Eleve.nom, Eleve.prenom).select_from(Paiement),
                         etablissement_id, du, au)
    paiements = q.join(Eleve, Inscription.eleve_id == Eleve.id).all()
    ventilations = {}
    if paiements:
        vq = (db.session.query(LignePaiement.paiement_id, TrancheClasse.categorie_entree_id,
                               db.func.sum(LignePaiement.montant_verse))
              .join(TrancheClasse, LignePaiement.tranche_classe_id == TrancheClasse.id)
              .filter(LignePaiement.paiement_id.in_([p.id for p, _, _ in paiements]))
              .group_by(LignePaiement.paiement_id, TrancheClasse.categorie_entree_id))
        for paiement_id, cid, montant in vq.all():
            parts = ventilations.setdefault(paiement_id, {})
            cle = cid or defaut
            parts[cle] = parts.get(cle, 0.0) + _f(montant)
    for p, nom, prenom in paiements:
        parts = ventilations.get(p.id, {})
        lignes.append({
            'origine': 'paiement', 'id': p.id, 'sens': 'ENTREE',
            'date': p.date_paiement.date().isoformat(), 'horodatage': p.date_paiement.isoformat() + 'Z',
            'libelle': f"Scolarité — {(nom or '').strip()} {(prenom or '').strip()}".strip(),
            'montant': _f(p.montant_total),
            'categorie_id': next(iter(parts)) if len(parts) == 1 else None,
            'ventilation': [{'categorie_id': c, 'montant': round(m, 2)} for c, m in parts.items()],
            'compte_id': compte_de_mode(p.mode_paiement, defauts), 'compte_destination_id': None,
            'tiers': None, 'reference': p.numero_recu, 'statut': p.statut, 'motif_annulation': None,
        })

    # Mouvements saisis
    mq = MouvementTresorerie.query.filter(
        MouvementTresorerie.etablissement_id == etablissement_id,
        MouvementTresorerie.date_operation >= du, MouvementTresorerie.date_operation <= au)
    if not avec_annules:
        mq = mq.filter(MouvementTresorerie.statut == 'VALIDE')
    for m in mq.all():
        d = m.to_dict()
        if m.sens == 'ENTREE':
            d['ventilation'] = [{'categorie_id': m.categorie_id, 'montant': d['montant']}]
        lignes.append({
            'origine': 'mouvement', 'id': m.id, 'sens': m.sens, 'date': d['date_operation'],
            'horodatage': m.cree_le.isoformat() + 'Z' if m.cree_le else None,
            'libelle': m.libelle, 'montant': d['montant'], 'categorie_id': m.categorie_id,
            'ventilation': d['ventilation'], 'compte_id': m.compte_id,
            'compte_destination_id': m.compte_destination_id, 'tiers': m.tiers, 'reference': m.reference,
            'statut': m.statut, 'motif_annulation': m.motif_annulation, 'version': m.version,
        })

    # Filtres
    if sens:
        lignes = [l for l in lignes if l['sens'] == sens]
    if categorie_id:
        lignes = [l for l in lignes if l['categorie_id'] == categorie_id
                  or any(v['categorie_id'] == categorie_id for v in l['ventilation'])]
    if compte_id:
        lignes = [l for l in lignes if compte_id in (l['compte_id'], l['compte_destination_id'])]

    lignes.sort(key=lambda l: (l['date'], l['horodatage'] or ''), reverse=True)
    return {'du': du.isoformat(), 'au': au.isoformat(), 'lignes': lignes}, 200


def get_synthese(etablissement_id, du=None, au=None):
    """Entrées et sorties de la période par catégorie, et soldes (cumulés
    jusqu'à `au`) de chaque fonds et de chaque compte."""
    du, au, erreur = _periode(du, au)
    if erreur:
        return {"erreur": erreur}, 400
    initialiser_tresorerie(etablissement_id)
    categories = {c.id: c for c in CategorieTresorerie.query.filter_by(etablissement_id=etablissement_id).all()}
    comptes = CompteTresorerie.query.filter_by(etablissement_id=etablissement_id).order_by(
        CompteTresorerie.type, CompteTresorerie.libelle).all()

    scolarite = _scolarite_par_fonds(etablissement_id, du, au)
    manuelles = _par_categorie('ENTREE', etablissement_id, du, au)
    sorties = _par_categorie('SORTIE', etablissement_id, du, au)
    imputees = _depenses_par_fonds(etablissement_id, du, au)

    def libelle(cid):
        return categories[cid].libelle if cid in categories else 'Sans catégorie'

    entrees_par_categorie = sorted((
        {'categorie_id': cid, 'libelle': libelle(cid),
         'montant': round(scolarite.get(cid, 0.0) + manuelles.get(cid, 0.0), 2),
         'dont_scolarite': round(scolarite.get(cid, 0.0), 2)}
        for cid in set(scolarite) | set(manuelles)), key=lambda x: -x['montant'])
    sorties_par_categorie = sorted((
        {'categorie_id': cid, 'libelle': libelle(cid), 'montant': round(m, 2)}
        for cid, m in sorties.items()), key=lambda x: -x['montant'])

    cumul_fonds = soldes_fonds(etablissement_id, au)
    fonds = []
    for c in sorted((c for c in categories.values() if c.type == 'ENTREE'),
                    key=lambda c: (not c.par_defaut, c.libelle)):
        cumul = cumul_fonds.get(c.id, {'entrees': 0.0, 'depenses': 0.0, 'solde': 0.0})
        entrees_periode = scolarite.get(c.id, 0.0) + manuelles.get(c.id, 0.0)
        fonds.append({'categorie_id': c.id, 'libelle': c.libelle, 'actif': c.actif, 'par_defaut': c.par_defaut,
                      'entrees_periode': round(entrees_periode, 2),
                      'depenses_periode': round(imputees.get(c.id, 0.0), 2), **cumul})

    cumul_comptes = soldes_comptes(etablissement_id, au)
    comptes_detail = [{'compte_id': c.id, 'libelle': c.libelle, 'type': c.type, 'actif': c.actif,
                       'par_defaut': c.par_defaut, 'solde': cumul_comptes.get(c.id, 0.0)} for c in comptes]

    total_entrees = round(sum(x['montant'] for x in entrees_par_categorie), 2)
    total_sorties = round(sum(x['montant'] for x in sorties_par_categorie), 2)
    return {
        'du': du.isoformat(), 'au': au.isoformat(),
        'total_entrees': total_entrees, 'total_sorties': total_sorties,
        'resultat': round(total_entrees - total_sorties, 2),
        'solde_global': round(sum(c['solde'] for c in comptes_detail), 2),
        'entrees_par_categorie': entrees_par_categorie,
        'sorties_par_categorie': sorties_par_categorie,
        'fonds': fonds,
        'comptes': comptes_detail,
    }, 200
