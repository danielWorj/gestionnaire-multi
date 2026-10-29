from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt

from services.paiements_services import (
    get_all_tranches_scoped, get_tranche_scoped, create_tranche_scoped,
    update_tranche_scoped, delete_tranche_scoped, dupliquer_echeancier_scoped,
    get_all_paiements_scoped, get_paiement_scoped, create_paiement_scoped,
    update_paiement_scoped, annuler_paiement_scoped,
    get_etat_paiements_inscription,
)


# ---------------------------------------------------------------------------
# Blueprints TRANCHE CLASSE et PAIEMENT — cloisonnés par etablissement_id
# (indirect dans les deux cas, cf. paiements_services.py : ni TrancheClasse
# ni Paiement ne portent de colonne etablissement_id directe).
#
# Réservés à Admin, SuperAdmin et Comptable, en LECTURE ET ÉCRITURE : le
# suivi financier (échéancier, versements) relève du service comptable
# (rôle 'Comptable', cf. Role.init_roles() dans authentification_models.py)
# et de l'administration de l'établissement — ni Censeur, ni Surveillant, ni
# Enseignant n'y ont accès, contrairement à d'autres modules cloisonnés par
# classe (Note/Discipline dans evaluation_api.py, Horaire dans
# emploi_du_temps_api.py, Inscription dans inscription_api.py).
#
# Admin d'établissement (et Comptable, rattaché lui aussi à un
# etablissement_id, cf. authentification_models.Utilisateur) limité à son
# propre établissement (claim JWT), SuperAdmin devant préciser
# ?etablissement_id=<id> (GET/PUT/DELETE) ou l'inclure dans le corps de la
# requête (POST) pour consulter/gérer un établissement donné — même logique
# que pedagogie_api.make_pedagogie_scoped_blueprint et
# structure_api.make_scoped_crud_blueprint.
# ---------------------------------------------------------------------------

ROLES_ACCES_PAIEMENTS = ("Admin", "SuperAdmin", "Comptable")


def _current_etablissement_id():
    """- Admin/Comptable d'établissement : toujours celui de son propre
      compte (claim JWT)
    - SuperAdmin : celui passé en query param, pour consulter un
      établissement précis"""
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        return request.args.get("etablissement_id", type=int)
    return claims.get("etablissement_id")


def _etablissement_id_pour_creation():
    """Même résolution que _current_etablissement_id, mais pour POST : le
    SuperAdmin précise etablissement_id dans le CORPS de la requête (pas en
    query param) — même logique que create() dans
    pedagogie_api.make_pedagogie_scoped_blueprint."""
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        return (request.get_json(silent=True) or {}).get("etablissement_id")
    return claims.get("etablissement_id")


# ---------------------------------------------------------------------------
# TRANCHE CLASSE (échéancier de paiement, par classe et année scolaire)
# ---------------------------------------------------------------------------

tranche_classe_bp = Blueprint('tranche_classe_api', __name__, url_prefix='/api/tranches-classe')


@tranche_classe_bp.before_request
@jwt_required()
def _require_role_tranche():
    if get_jwt().get("role") not in ROLES_ACCES_PAIEMENTS:
        return jsonify({"erreur": "Accès non autorisé"}), 403


@tranche_classe_bp.route('/', methods=['GET'])
def tranche_get_all():
    etab_id = _current_etablissement_id()
    if etab_id is None:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    # Filtres optionnels : consulter l'échéancier d'UNE classe/année précise
    # (cas d'usage principal côté front : afficher l'échéancier d'une classe
    # avant d'y rattacher un paiement) plutôt que tout l'établissement.
    classe_id = request.args.get("classe_id", type=int)
    annee_scolaire_id = request.args.get("annee_scolaire_id", type=int)
    return jsonify(get_all_tranches_scoped(etab_id, classe_id, annee_scolaire_id)), 200


@tranche_classe_bp.route('/', methods=['POST'])
def tranche_create():
    etab_id = _etablissement_id_pour_creation()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = create_tranche_scoped(request.get_json(), etab_id)
    return jsonify(result), status


@tranche_classe_bp.route('/<int:id>', methods=['GET'])
def tranche_get_one(id):
    etab_id = _current_etablissement_id()
    entity = get_tranche_scoped(id, etab_id) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Tranche non trouvée"}), 404
    return jsonify(entity.to_dict()), 200


@tranche_classe_bp.route('/<int:id>', methods=['PUT'])
def tranche_update(id):
    etab_id = _current_etablissement_id()
    entity = get_tranche_scoped(id, etab_id) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Tranche non trouvée"}), 404
    result, status = update_tranche_scoped(entity, request.get_json(), etab_id)
    return jsonify(result), status


@tranche_classe_bp.route('/<int:id>', methods=['DELETE'])
def tranche_delete(id):
    etab_id = _current_etablissement_id()
    entity = get_tranche_scoped(id, etab_id) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Tranche non trouvée"}), 404
    result, status = delete_tranche_scoped(entity, etab_id)
    return jsonify(result), status


@tranche_classe_bp.route('/dupliquer', methods=['POST'])
def tranche_dupliquer():
    """Duplique l'échéancier d'une classe d'une année scolaire source vers
    une année cible (cf. docstring de TrancheClasse sur la rentrée
    scolaire). Body attendu : {classe_id, annee_source_id, annee_cible_id}."""
    etab_id = _etablissement_id_pour_creation()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    body = request.get_json(silent=True) or {}
    for champ in ('classe_id', 'annee_source_id', 'annee_cible_id'):
        if body.get(champ) in (None, ''):
            return jsonify({"erreur": f"{champ} requis"}), 400
    result, status = dupliquer_echeancier_scoped(
        body['classe_id'], body['annee_source_id'], body['annee_cible_id'], etab_id
    )
    return jsonify(result), status


# ---------------------------------------------------------------------------
# PAIEMENT (en-tête + lignes de ventilation sur les tranches)
# ---------------------------------------------------------------------------

paiement_bp = Blueprint('paiement_api', __name__, url_prefix='/api/paiements')


@paiement_bp.before_request
@jwt_required()
def _require_role_paiement():
    if get_jwt().get("role") not in ROLES_ACCES_PAIEMENTS:
        return jsonify({"erreur": "Accès non autorisé"}), 403


@paiement_bp.route('/', methods=['GET'])
def paiement_get_all():
    etab_id = _current_etablissement_id()
    if etab_id is None:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    inscription_id = request.args.get("inscription_id", type=int)
    statut = request.args.get("statut")
    return jsonify(get_all_paiements_scoped(etab_id, inscription_id, statut)), 200


@paiement_bp.route('/', methods=['POST'])
def paiement_create():
    """Crée l'en-tête ET les lignes en un seul appel. Body attendu :
    {inscription_id, parent_id, encaisse_par_id, numero_recu, montant_total,
     mode_paiement, reference_transaction?,
     lignes: [{tranche_classe_id, montant_verse}, ...]}."""
    etab_id = _etablissement_id_pour_creation()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = create_paiement_scoped(request.get_json(), etab_id)
    return jsonify(result), status


@paiement_bp.route('/<int:id>', methods=['GET'])
def paiement_get_one(id):
    etab_id = _current_etablissement_id()
    entity = get_paiement_scoped(id, etab_id) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Paiement non trouvé"}), 404
    return jsonify(entity.to_dict(with_lignes=True)), 200


@paiement_bp.route('/<int:id>', methods=['PUT'])
def paiement_update(id):
    """Modification limitée à mode_paiement / reference_transaction, cf.
    docstring de update_paiement_scoped — pour tout le reste (montant,
    lignes, inscription...), annuler ce paiement puis en recréer un
    nouveau."""
    etab_id = _current_etablissement_id()
    entity = get_paiement_scoped(id, etab_id) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Paiement non trouvé"}), 404
    result, status = update_paiement_scoped(entity, request.get_json(), etab_id)
    return jsonify(result), status


@paiement_bp.route('/<int:id>/annuler', methods=['POST'])
def paiement_annuler(id):
    """Annulation d'un paiement (statut -> ANNULE) : neutralise d'un coup
    toutes ses lignes de ventilation, cf. docstring de
    annuler_paiement_scoped. Body attendu : {motif_annulation}. Aucun
    DELETE n'est exposé sur ce blueprint : on n'efface jamais un historique
    de paiements, on l'annule."""
    etab_id = _current_etablissement_id()
    entity = get_paiement_scoped(id, etab_id) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Paiement non trouvé"}), 404
    motif = (request.get_json(silent=True) or {}).get("motif_annulation")
    result, status = annuler_paiement_scoped(entity, motif, etab_id)
    return jsonify(result), status


@paiement_bp.route('/etat/<int:inscription_id>', methods=['GET'])
def paiement_etat_inscription(inscription_id):
    """Renvoie {tranches: [...], solde: float} pour l'inscription donnée
    (cf. docstring de get_etat_paiements_inscription)."""
    etab_id = _current_etablissement_id()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    etat = get_etat_paiements_inscription(inscription_id, etab_id)
    if etat is None:
        return jsonify({"erreur": "Inscription non trouvée"}), 404
    return jsonify(etat), 200