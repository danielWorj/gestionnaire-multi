from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from services.superadmin_services import (
    creer_superadmin, lister_superadmins, modifier_superadmin, reinitialiser_mdp_superadmin, vue_reseau,
)

# ---------------------------------------------------------------------------
# Supervision de la plateforme — SuperAdmin uniquement.
#
# GET  /api/superadmin/vue-reseau                     indicateurs de tous les établissements
# GET  /api/superadmin/comptes                        comptes SuperAdmin
# POST /api/superadmin/comptes                        {nom, email} -> mot de passe généré (affiché une fois)
# PUT  /api/superadmin/comptes/<id>                   {nom?, email?, actif?}
# POST /api/superadmin/comptes/<id>/reinitialiser     nouveau mot de passe généré
#
# Garde-fous : on ne se désactive pas soi-même, il reste toujours au moins
# un SuperAdmin actif, et la réinitialisation ne vise que les AUTRES comptes
# (pour soi : /api/auth/superadmin/change-password, qui exige l'ancien).
# ---------------------------------------------------------------------------

superadmin_supervision_bp = Blueprint('superadmin_supervision', __name__, url_prefix='/api/superadmin')


@superadmin_supervision_bp.before_request
@jwt_required()
def _require_superadmin():
    claims = get_jwt()
    if claims.get('type_compte') != 'superadmin' or claims.get('role') != 'SuperAdmin':
        return jsonify({"erreur": "Accès réservé au SuperAdmin"}), 403
    return None


def _courant_id():
    return int(get_jwt_identity())


@superadmin_supervision_bp.route('/vue-reseau', methods=['GET'])
def vue_reseau_endpoint():
    return jsonify(vue_reseau()), 200


@superadmin_supervision_bp.route('/comptes', methods=['GET'])
def comptes_liste():
    return jsonify(lister_superadmins()), 200


@superadmin_supervision_bp.route('/comptes', methods=['POST'])
def comptes_creer():
    result, status = creer_superadmin(request.get_json(silent=True) or {})
    return jsonify(result), status


@superadmin_supervision_bp.route('/comptes/<int:compte_id>', methods=['PUT'])
def comptes_modifier(compte_id):
    result, status = modifier_superadmin(compte_id, request.get_json(silent=True) or {}, _courant_id())
    return jsonify(result), status


@superadmin_supervision_bp.route('/comptes/<int:compte_id>/reinitialiser', methods=['POST'])
def comptes_reinitialiser(compte_id):
    result, status = reinitialiser_mdp_superadmin(compte_id, _courant_id())
    return jsonify(result), status
