"""Listes de classe : lecture seule, ouverte à tous les profils
d'établissement, chacun sur ses classes (cf. services/liste_classe_services.py).

GET /api/listes-classes/                 -> {classes, annees_scolaires, avec_parents}
GET /api/listes-classes/eleves?annee_scolaire_id=<id>[&classe_id=<id>]
                                         -> [ligne par inscription]
"""
from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from services.liste_classe_services import ROLES_LISTES_CLASSE, contexte_listes, eleves_listes

liste_classe_bp = Blueprint('liste_classe_api', __name__, url_prefix='/api/listes-classes')


@liste_classe_bp.before_request
@jwt_required()
def _require_role():
    if get_jwt().get("role") not in ROLES_LISTES_CLASSE:
        return jsonify({"erreur": "Accès non autorisé"}), 403
    return None


def _contexte():
    claims = get_jwt()
    role = claims.get("role")
    etab_id = (request.args.get("etablissement_id", type=int) if role == "SuperAdmin"
               else claims.get("etablissement_id"))
    return role, int(get_jwt_identity()), etab_id


@liste_classe_bp.route('/', methods=['GET'])
def listes_contexte():
    role, user_id, etab_id = _contexte()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    return jsonify(contexte_listes(role, user_id, etab_id)), 200


@liste_classe_bp.route('/eleves', methods=['GET'])
def listes_eleves():
    role, user_id, etab_id = _contexte()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    annee_id = request.args.get("annee_scolaire_id", type=int)
    if not annee_id:
        return jsonify({"erreur": "annee_scolaire_id requis"}), 400
    lignes, status = eleves_listes(role, user_id, etab_id, annee_id, request.args.get("classe_id", type=int))
    if status == 403:
        return jsonify({"erreur": "Cette classe ne fait pas partie de vos classes"}), 403
    return jsonify(lignes), 200
