from datetime import date

from flask import current_app
from sqlalchemy.exc import IntegrityError

from models.paiements_models import TrancheClasse, Paiement, LignePaiement
from models.inscription_models import Inscription, Parent
from models.structure_models import Classe, AnneeScolaire
from models.authentification_models import Utilisateur
from extensions import db

# Les opérations CRUD "brutes" génériques (create_entity, get_all_entities,
# get_entity_by_id, update_entity, delete_entity) restent réutilisées pour
# TrancheClasse — même logique que pedagogie_services.py,
# emploi_du_temps_services.py, inscription_services.py et
# evaluation_services.py. Paiement/LignePaiement, eux, ne s'y prêtent plus :
# leur création est une opération TRANSACTIONNELLE à deux tables (en-tête +
# lignes), traitée à part plus bas.
from services.structure_services import (
    create_entity, get_all_entities, get_entity_by_id, update_entity, delete_entity,
)


# ---------------------------------------------------------------------------
# Cloisonnement par établissement
#
# Ni TrancheClasse, ni Paiement, ni LignePaiement ne portent de colonne
# etablissement_id directe (cf. docstring de paiements_models.py) :
#   - TrancheClasse : UN saut -> classe_id -> Classe.etablissement_id
#   - Paiement       : UN saut -> inscription_id -> Inscription.classe_id ->
#     Classe.etablissement_id
#   - LignePaiement  : déduit de paiement_id -> Paiement (voir ci-dessus)
#
# Toujours aucun mécanisme de classe_ids_restriction ici : ce module reste
# exclusivement réservé à Admin/SuperAdmin/Comptable (cf. paiements_api.py,
# ROLES_ACCES_PAIEMENTS), jamais exposé à un Censeur/Surveillant/Enseignant.
# ---------------------------------------------------------------------------

MODES_PAIEMENT_VALIDES = ('ESPECES', 'MOBILE_MONEY', 'VIREMENT', 'CHEQUE')
STATUTS_PAIEMENT_VALIDES = ('VALIDE', 'ANNULE', 'REJETE', 'REMBOURSE')


def get_etablissement_id_of_tranche(tranche):
    """Retourne l'etablissement_id 'propriétaire' d'une TrancheClasse,
    déduit de sa classe."""
    return tranche.classe.etablissement_id


def get_etablissement_id_of_paiement(paiement):
    """Retourne l'etablissement_id 'propriétaire' d'un Paiement, déduit via
    son Inscription."""
    return paiement.inscription.classe.etablissement_id


def _validate_montant_positif(data, champ):
    """Vérifie que data[champ], si fourni, est un nombre strictement positif
    — même borne que les CheckConstraint en base, vérifiée ici en amont pour
    renvoyer un message clair plutôt qu'une IntegrityError brute (même
    logique que evaluation_services._validate_valeur)."""
    if champ not in data or data[champ] is None:
        return None
    try:
        valeur = float(data[champ])
    except (TypeError, ValueError):
        return f"{champ} invalide"
    if valeur <= 0:
        return f"{champ} doit être strictement positif"
    return None


# ===========================================================================
# TRANCHE CLASSE (échéancier)
#
# Référentiel financier par classe (contrairement à l'ancien
# TranchePaiement, établissement-large via AnneeScolaire seule) : lecture +
# écriture pour Admin/SuperAdmin/Comptable, cf. paiements_api.py.
# ===========================================================================

def _tranche_query(etablissement_id):
    return (
        TrancheClasse.query
        .join(Classe, TrancheClasse.classe_id == Classe.id)
        .filter(Classe.etablissement_id == etablissement_id)
    )


def _validate_tranche_foreign_keys(data, etablissement_id):
    """Empêche un établissement de rattacher une tranche à une Classe ou une
    AnneeScolaire appartenant à un AUTRE établissement, et impose que les
    deux (quand les deux sont fournies) portent bien sur le même
    établissement — pas de contrôle de cohérence classe/année ici (une
    classe n'est pas rattachée à UNE année scolaire précise), uniquement un
    contrôle de propriété établissement de chaque côté."""
    classe = None
    annee = None

    if 'classe_id' in data:
        classe = db.session.get(Classe, data['classe_id'])
        if not classe or classe.etablissement_id != etablissement_id:
            return "Classe invalide pour cet établissement"

    if 'annee_scolaire_id' in data:
        annee = db.session.get(AnneeScolaire, data['annee_scolaire_id'])
        if not annee or annee.etablissement_id != etablissement_id:
            return "Année scolaire invalide pour cet établissement"

    return None


def get_all_tranches_scoped(etablissement_id, classe_id=None, annee_scolaire_id=None):
    query = _tranche_query(etablissement_id)
    if classe_id is not None:
        query = query.filter(TrancheClasse.classe_id == classe_id)
    if annee_scolaire_id is not None:
        query = query.filter(TrancheClasse.annee_scolaire_id == annee_scolaire_id)
    return [t.to_dict() for t in query.order_by(TrancheClasse.ordre).all()]


def get_tranche_scoped(tranche_id, etablissement_id):
    """Renvoie None si la TrancheClasse n'existe pas OU n'appartient pas à
    l'établissement (on ne distingue pas les deux cas côté API, pour ne pas
    révéler l'existence de ressources d'un autre établissement)."""
    entity = db.session.get(TrancheClasse, tranche_id)
    if not entity or get_etablissement_id_of_tranche(entity) != etablissement_id:
        return None
    return entity


def create_tranche_scoped(data, etablissement_id):
    data = dict(data or {})

    for champ in ('classe_id', 'annee_scolaire_id', 'libelle', 'ordre', 'montant_attendu'):
        if data.get(champ) in (None, ''):
            return {"erreur": f"{champ} requis"}, 400

    error = _validate_tranche_foreign_keys(data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    try:
        ordre = int(data['ordre'])
    except (TypeError, ValueError):
        return {"erreur": "ordre invalide"}, 400
    if ordre <= 0:
        return {"erreur": "ordre doit être strictement positif"}, 400

    error = _validate_montant_positif(data, 'montant_attendu')
    if error:
        return {"erreur": error}, 400

    return create_entity(TrancheClasse, data)


def update_tranche_scoped(entity, data, etablissement_id):
    if get_etablissement_id_of_tranche(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    data = dict(data or {})

    error = _validate_tranche_foreign_keys(data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    if 'ordre' in data and data['ordre'] is not None:
        try:
            if int(data['ordre']) <= 0:
                return {"erreur": "ordre doit être strictement positif"}, 400
        except (TypeError, ValueError):
            return {"erreur": "ordre invalide"}, 400

    error = _validate_montant_positif(data, 'montant_attendu')
    if error:
        return {"erreur": error}, 400

    return update_entity(entity, data)


def delete_tranche_scoped(entity, etablissement_id):
    if get_etablissement_id_of_tranche(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    # Les LignePaiement rattachées à cette tranche (FK tranche_classe_id) ne
    # sont pas nettoyées ici : la contrainte de clé étrangère en base (sans
    # ON DELETE CASCADE) fera échouer la suppression via l'IntegrityError
    # déjà gérée par delete_entity, tant qu'une ligne y fait encore
    # référence — comportement volontaire, on ne supprime jamais
    # silencieusement un historique de paiements.
    return delete_entity(entity)


def dupliquer_echeancier_scoped(classe_id, annee_source_id, annee_cible_id, etablissement_id):
    """Duplique les TrancheClasse de (classe_id, annee_source_id) vers
    (classe_id, annee_cible_id), montants et dates limites inclus (ceux-ci
    peuvent ensuite être ajustés individuellement via update_tranche_scoped)
    — cf. docstring de TrancheClasse sur la rentrée scolaire. Ignore les
    tranches dont le libellé existe déjà pour l'année cible (uq_tranche_libelle),
    pour permettre un ré-appel sans doublon en cas de duplication partielle
    déjà effectuée.

    Renvoie (résultat, statut) : la liste des tranches créées en cas de
    succès, ou un message d'erreur si la classe/l'une des deux années est
    invalide pour l'établissement."""
    classe = db.session.get(Classe, classe_id)
    if not classe or classe.etablissement_id != etablissement_id:
        return {"erreur": "Classe invalide pour cet établissement"}, 400

    for annee_id in (annee_source_id, annee_cible_id):
        annee = db.session.get(AnneeScolaire, annee_id)
        if not annee or annee.etablissement_id != etablissement_id:
            return {"erreur": "Année scolaire invalide pour cet établissement"}, 400

    if annee_source_id == annee_cible_id:
        return {"erreur": "L'année source et l'année cible doivent être différentes"}, 400

    deja_presentes = {
        libelle for (libelle,) in
        db.session.query(TrancheClasse.libelle)
        .filter_by(classe_id=classe_id, annee_scolaire_id=annee_cible_id)
        .all()
    }

    sources = (
        TrancheClasse.query
        .filter_by(classe_id=classe_id, annee_scolaire_id=annee_source_id)
        .order_by(TrancheClasse.ordre)
        .all()
    )

    creees = []
    try:
        for source in sources:
            if source.libelle in deja_presentes:
                continue
            copie = TrancheClasse(
                classe_id=classe_id,
                annee_scolaire_id=annee_cible_id,
                libelle=source.libelle,
                ordre=source.ordre,
                montant_attendu=source.montant_attendu,
                date_limite=source.date_limite,
            )
            db.session.add(copie)
            creees.append(copie)
        db.session.commit()
    except IntegrityError as e:
        db.session.rollback()
        current_app.logger.error("IntegrityError sur dupliquer_echeancier_scoped : %s", getattr(e, "orig", e))
        return {"erreur": "Violation de contrainte d'unicité"}, 409
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la duplication de l'échéancier"}, 500

    return [t.to_dict() for t in creees], 201


# ===========================================================================
# PAIEMENT + LIGNES
#
# Lecture + écriture réservées à Admin/SuperAdmin/Comptable (cf.
# paiements_api.py) — mêmes rôles que TrancheClasse, aucune restriction par
# classe (ce module n'est jamais exposé à un Censeur/Surveillant).
#
# Contrairement à TrancheClasse, Paiement n'est pas géré par le CRUD
# générique : la création engage l'en-tête ET ses lignes dans une même
# transaction (cf. docstring de LignePaiement), et la modification d'un
# paiement existant est volontairement limitée (cf. update_paiement_scoped)
# — l'historique financier ne se corrige pas en place, il s'annule
# (cf. annuler_paiement_scoped).
# ===========================================================================

def _paiement_query(etablissement_id):
    return (
        Paiement.query
        .join(Inscription, Paiement.inscription_id == Inscription.id)
        .join(Classe, Inscription.classe_id == Classe.id)
        .filter(Classe.etablissement_id == etablissement_id)
    )


def _validate_paiement_entete(data, etablissement_id):
    """Vérifie inscription_id, parent_id et encaisse_par_id : appartenance à
    l'établissement, et cohérence parent_id/inscription (le parent qui paie
    doit être celui de l'élève inscrit, sauf s'il n'a pas encore été
    renseigné — auquel cas la Cohérence Eleve.parent_id garantit déjà sa
    présence, cf. ck_eleve_parent dans inscription_models.py). Retourne
    (inscription, message_erreur) — message_erreur est None si tout est
    valide."""
    inscription = None

    if 'inscription_id' in data:
        inscription = db.session.get(Inscription, data['inscription_id'])
        if not inscription or inscription.classe.etablissement_id != etablissement_id:
            return None, "Inscription invalide pour cet établissement"

    if 'parent_id' in data:
        parent = db.session.get(Parent, data['parent_id'])
        if not parent or parent.etablissement_id != etablissement_id:
            return inscription, "Parent invalide pour cet établissement"
        if inscription is not None and inscription.eleve.parent_id != parent.id:
            return inscription, "Ce parent n'est pas celui de l'élève inscrit"

    if 'encaisse_par_id' in data:
        agent = db.session.get(Utilisateur, data['encaisse_par_id'])
        if not agent or (
            getattr(agent, 'etablissement_id', None) is not None
            and agent.etablissement_id != etablissement_id
        ):
            return inscription, "Agent encaisseur invalide pour cet établissement"

    return inscription, None


def _validate_lignes_paiement(lignes_data, inscription, montant_total):
    """Vérifie la liste des lignes soumises à la création d'un paiement :
      - au moins une ligne (1..* sur le diagramme)
      - chaque tranche_classe_id existe, appartient à LA MÊME classe et LA
        MÊME année scolaire que l'inscription du paiement (les deux chemins
        de rattachement établissement doivent converger)
      - pas de tranche en double au sein des lignes soumises
        (uq_ligne_paiement_tranche)
      - chaque montant_verse est strictement positif
      - SUM(montant_verse) == montant_total (contrôle, cf. docstring de
        Paiement.montant_total)
    Retourne (tranches_par_id, message_erreur)."""
    if not lignes_data:
        return {}, "Au moins une ligne de paiement (lignes) est requise"

    tranche_ids_vus = set()
    tranches_par_id = {}
    somme = 0.0

    for ligne in lignes_data:
        tranche_id = ligne.get('tranche_classe_id')
        montant = ligne.get('montant_verse')

        if tranche_id in (None, ''):
            return {}, "tranche_classe_id requis pour chaque ligne"
        if tranche_id in tranche_ids_vus:
            return {}, "Une même tranche ne peut apparaître deux fois dans les lignes d'un paiement"
        tranche_ids_vus.add(tranche_id)

        tranche = db.session.get(TrancheClasse, tranche_id)
        if not tranche:
            return {}, f"Tranche {tranche_id} invalide"
        if tranche.classe_id != inscription.classe_id or tranche.annee_scolaire_id != inscription.annee_scolaire_id:
            return {}, (
                f"La tranche {tranche_id} ne correspond pas à la classe/année scolaire de l'inscription"
            )

        try:
            montant = float(montant)
        except (TypeError, ValueError):
            return {}, "montant_verse invalide pour une ligne"
        if montant <= 0:
            return {}, "montant_verse doit être strictement positif pour chaque ligne"

        tranches_par_id[tranche_id] = tranche
        somme += montant

    try:
        montant_total = float(montant_total)
    except (TypeError, ValueError):
        return {}, "montant_total invalide"

    if round(somme, 2) != round(montant_total, 2):
        return {}, (
            "La somme des lignes de paiement ne correspond pas au montant_total déclaré"
        )

    return tranches_par_id, None


def get_all_paiements_scoped(etablissement_id, inscription_id=None, statut=None):
    query = _paiement_query(etablissement_id)
    if inscription_id is not None:
        query = query.filter(Paiement.inscription_id == inscription_id)
    if statut is not None:
        query = query.filter(Paiement.statut == statut)
    return [p.to_dict(with_lignes=True) for p in query.order_by(Paiement.date_paiement.desc()).all()]


def get_paiement_scoped(paiement_id, etablissement_id):
    """Renvoie None si le Paiement n'existe pas OU n'appartient pas à
    l'établissement — sans distinguer ces cas côté API, pour ne pas révéler
    l'existence de ressources d'un autre établissement."""
    entity = db.session.get(Paiement, paiement_id)
    if not entity or get_etablissement_id_of_paiement(entity) != etablissement_id:
        return None
    return entity


def create_paiement_scoped(data, etablissement_id):
    """Crée l'en-tête Paiement ET ses LignePaiement en une seule
    transaction (cf. docstring de LignePaiement : 'en-tête et lignes créés
    dans une même transaction'). Payload attendu :
    {inscription_id, parent_id, encaisse_par_id, numero_recu, montant_total,
     mode_paiement, reference_transaction?, lignes: [{tranche_classe_id,
     montant_verse}, ...]}."""
    data = dict(data or {})

    for champ in ('inscription_id', 'parent_id', 'encaisse_par_id', 'numero_recu',
                  'montant_total', 'mode_paiement'):
        if data.get(champ) in (None, ''):
            return {"erreur": f"{champ} requis"}, 400

    if data['mode_paiement'] not in MODES_PAIEMENT_VALIDES:
        return {"erreur": "mode_paiement invalide"}, 400

    error = _validate_montant_positif(data, 'montant_total')
    if error:
        return {"erreur": error}, 400

    inscription, error = _validate_paiement_entete(data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    lignes_data = data.get('lignes') or []
    _, error = _validate_lignes_paiement(lignes_data, inscription, data['montant_total'])
    if error:
        return {"erreur": error}, 400

    try:
        paiement = Paiement(
            inscription_id=data['inscription_id'],
            parent_id=data['parent_id'],
            encaisse_par_id=data['encaisse_par_id'],
            numero_recu=data['numero_recu'],
            montant_total=data['montant_total'],
            mode_paiement=data['mode_paiement'],
            reference_transaction=data.get('reference_transaction'),
            statut='VALIDE',
        )
        db.session.add(paiement)
        db.session.flush()  # pour obtenir paiement.id avant d'insérer les lignes

        for ligne in lignes_data:
            db.session.add(LignePaiement(
                paiement_id=paiement.id,
                tranche_classe_id=ligne['tranche_classe_id'],
                montant_verse=ligne['montant_verse'],
            ))

        db.session.commit()
        return paiement.to_dict(with_lignes=True), 201
    except IntegrityError as e:
        db.session.rollback()
        current_app.logger.error("IntegrityError sur create_paiement_scoped : %s", getattr(e, "orig", e))
        return {"erreur": "Violation de contrainte d'unicité (numéro de reçu déjà utilisé ?)"}, 409
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la création du paiement"}, 500


def update_paiement_scoped(entity, data, etablissement_id):
    """Modification volontairement LIMITÉE : seuls mode_paiement et
    reference_transaction (informations de traçabilité) sont modifiables
    après coup. inscription_id, parent_id, encaisse_par_id, numero_recu,
    montant_total et les lignes ne le sont PAS — un versement mal saisi
    s'annule (cf. annuler_paiement_scoped) puis se ressaisit, il ne se
    corrige jamais en place, pour ne pas désynchroniser le reçu papier déjà
    remis au parent."""
    if get_etablissement_id_of_paiement(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    if entity.statut != 'VALIDE':
        return {"erreur": "Ce paiement n'est plus modifiable (statut non VALIDE)"}, 400

    data = dict(data or {})
    champs_autorises = {}

    if 'mode_paiement' in data:
        if data['mode_paiement'] not in MODES_PAIEMENT_VALIDES:
            return {"erreur": "mode_paiement invalide"}, 400
        champs_autorises['mode_paiement'] = data['mode_paiement']

    if 'reference_transaction' in data:
        champs_autorises['reference_transaction'] = data['reference_transaction']

    if not champs_autorises:
        return {"erreur": "Aucun champ modifiable fourni (seuls mode_paiement et reference_transaction le sont)"}, 400

    return update_entity(entity, champs_autorises)


def annuler_paiement_scoped(entity, motif_annulation, etablissement_id):
    """Fait basculer un Paiement VALIDE vers le statut ANNULE, en imposant
    un motif (ck_paiement_annulation) — neutralise d'un coup toutes ses
    LignePaiement (le statut porte sur l'en-tête, pas sur les lignes, cf.
    docstring de Paiement). Les calculs de paye/reste_du/solde (cf.
    get_etat_paiements_inscription) filtrent déjà sur statut == 'VALIDE',
    donc un paiement annulé cesse immédiatement de compter dans les
    montants versés — sans qu'il soit nécessaire de toucher aux lignes."""
    if get_etablissement_id_of_paiement(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    if entity.statut == 'ANNULE':
        return {"erreur": "Ce paiement est déjà annulé"}, 400

    if not motif_annulation:
        return {"erreur": "motif_annulation requis"}, 400

    return update_entity(entity, {"statut": "ANNULE", "motif_annulation": motif_annulation})


# ---------------------------------------------------------------------------
# État des paiements d'une Inscription : pour chaque TrancheClasse de
# l'échéancier (classe_id + annee_scolaire_id de l'inscription), montant
# attendu vs total déjà versé (somme des LignePaiement des Paiement de
# statut VALIDE, cf. docstring de LignePaiement) — utilisé pour afficher un
# récapitulatif/solde côté front, même esprit que Classe.effectif
# (structure_models.py) ou censeur_espace.censeur_roster (evaluation_api.py).
#
# Le solde global n'est jamais stocké (cf. docstring de LignePaiement) : il
# est recalculé à chaque appel à partir des seuls paiements VALIDE.
#
# SOLVABILITÉ — statut dérivé de l'échéancier (cf. calculer_solvabilite) :
#   - SOLVABLE   : l'élève a payé au moins une tranche de l'échéancier de sa
#                  classe pour cette année scolaire, ET aucune tranche
#                  restante n'a d'échéance dépassée (en_retard) — que TOUTES
#                  les tranches soient déjà réglées, ou qu'il en reste dont
#                  la date_limite n'est simplement pas encore passée : dans
#                  les deux cas l'élève est à jour, donc solvable.
#   - INSOLVABLE :
#       (3.1) aucune tranche payée du tout (montant_verse == 0 partout), OU
#       (3.2) au moins une tranche est en_retard (date_limite dépassée ET
#             reste_du > 0), qu'il s'agisse ou non de la même tranche que
#             celles déjà payées.
#   Un élève sans échéancier défini pour sa classe/année (tranches vide)
#   n'est ni solvable ni insolvable : solvabilite=None.
# ---------------------------------------------------------------------------

def calculer_solvabilite(tranches_detail):
    """tranches_detail : la liste 'tranches' telle que renvoyée par
    get_etat_paiements_inscription (chaque élément porte déjà montant_verse
    et en_retard). Renvoie (statut, motif) où statut est l'une des chaînes
    'SOLVABLE' / 'INSOLVABLE' / None (pas d'échéancier)."""
    if not tranches_detail:
        return None, "Aucun échéancier défini pour cette classe/année scolaire"

    aucune_tranche_payee = all(t["montant_verse"] == 0 for t in tranches_detail)
    if aucune_tranche_payee:
        return "INSOLVABLE", "Aucune tranche payée dans cette classe pour cette année scolaire"

    a_une_tranche_en_retard = any(t["en_retard"] for t in tranches_detail)
    if a_une_tranche_en_retard:
        return "INSOLVABLE", "Une ou plusieurs tranches sont en retard (échéance dépassée) avec solde restant"

    return "SOLVABLE", None


def get_etat_paiements_inscription(inscription_id, etablissement_id):
    """Renvoie None si l'inscription n'existe pas ou n'appartient pas à
    l'établissement ; sinon un dict {tranches: [...], solde: float,
    solvabilite: str|None, motif_solvabilite: str|None} où chaque tranche
    porte {tranche_classe_id, libelle, ordre, montant_attendu, date_limite,
    montant_verse, reste_du, en_retard}. Voir calculer_solvabilite ci-dessus
    pour la définition exacte de solvabilite."""
    inscription = db.session.get(Inscription, inscription_id)
    if not inscription or inscription.classe.etablissement_id != etablissement_id:
        return None

    tranches = (
        TrancheClasse.query
        .filter_by(classe_id=inscription.classe_id, annee_scolaire_id=inscription.annee_scolaire_id)
        .order_by(TrancheClasse.ordre)
        .all()
    )

    aujourdhui = date.today()
    detail = []
    total_attendu = 0.0
    total_verse_paiements = 0.0

    for tranche in tranches:
        total_ligne = (
            db.session.query(db.func.coalesce(db.func.sum(LignePaiement.montant_verse), 0))
            .join(Paiement, LignePaiement.paiement_id == Paiement.id)
            .filter(
                LignePaiement.tranche_classe_id == tranche.id,
                Paiement.inscription_id == inscription_id,
                Paiement.statut == 'VALIDE',
            )
            .scalar()
        )
        montant_attendu = float(tranche.montant_attendu)
        montant_verse = float(total_ligne)
        reste_du = round(montant_attendu - montant_verse, 2)
        en_retard = bool(tranche.date_limite and aujourdhui > tranche.date_limite and reste_du > 0)

        total_attendu += montant_attendu
        detail.append({
            "tranche_classe_id": tranche.id,
            "libelle": tranche.libelle,
            "ordre": tranche.ordre,
            "montant_attendu": montant_attendu,
            "date_limite": tranche.date_limite.isoformat() if tranche.date_limite else None,
            "montant_verse": montant_verse,
            "reste_du": reste_du,
            "en_retard": en_retard,
        })

    total_verse_paiements = (
        db.session.query(db.func.coalesce(db.func.sum(Paiement.montant_total), 0))
        .filter(Paiement.inscription_id == inscription_id, Paiement.statut == 'VALIDE')
        .scalar()
    )

    solde = round(total_attendu - float(total_verse_paiements), 2)

    solvabilite, motif_solvabilite = calculer_solvabilite(detail)

    return {
        "tranches": detail,
        "solde": solde,
        "solvabilite": solvabilite,
        "motif_solvabilite": motif_solvabilite,
    }