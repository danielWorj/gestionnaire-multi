from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from services.pedagogie_services import resolve_classe_ids_restriction
from services.trous_services import (
    PeriodeErreur, combler_trou, lister_trous, poser_dispense, retirer_dispense,
)

# ---------------------------------------------------------------------------
# Notes manquantes avant un bulletin / un procès-verbal (cf. trous_services) :
#   GET  /api/trous/?classe_id=&annee_scolaire_id=&periode=   -> élèves et trous
#   POST /api/trous/note              {inscription_id, matiere_classe_id,
#                                      sequence_id, composante?, valeur|absent}
#   POST /api/trous/dispense          {inscription_id, matiere_classe_id, sequence_id, motif?}
#   POST /api/trous/dispense/retirer  {inscription_id, matiere_classe_id, sequence_id}
#
# Admin / SuperAdmin : toutes les classes ; Censeur : ses classes assignées ;
# Enseignant : les classes dont il est titulaire.
# ---------------------------------------------------------------------------

ROLES_TROUS = ("Admin", "SuperAdmin", "Censeur", "Enseignant")

trous_bp = Blueprint('trous_api', __name__, url_prefix='/api/trous')


@trous_bp.before_request
@jwt_required()
def _require_role_trous():
    if get_jwt().get("role") not in ROLES_TROUS:
        return jsonify({"erreur": "Accès non autorisé"}), 403


@trous_bp.errorhandler(PeriodeErreur)
def _erreur(err):
    return jsonify({"erreur": err.message}), err.status


def _etablissement_id():
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        return request.args.get("etablissement_id", type=int)
    return claims.get("etablissement_id")


def _restriction():
    role = get_jwt().get("role")
    if role in ("Admin", "SuperAdmin"):
        return None
    return resolve_classe_ids_restriction(role, int(get_jwt_identity()))


def _contexte():
    etab_id = _etablissement_id()
    if not etab_id:
        raise PeriodeErreur("etablissement_id requis")
    return etab_id, (request.get_json(silent=True) or {})


@trous_bp.route('/', methods=['GET'])
def trous_liste():
    etab_id = _etablissement_id()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    return jsonify(lister_trous(etab_id, request.args.get("classe_id", type=int),
                                request.args.get("annee_scolaire_id", type=int),
                                request.args.get("periode"), _restriction())), 200


@trous_bp.route('/note', methods=['POST'])
def trous_note():
    etab_id, data = _contexte()
    result, status = combler_trou(etab_id, data, _restriction())
    return jsonify(result), status


@trous_bp.route('/dispense', methods=['POST'])
def trous_dispense():
    etab_id, data = _contexte()
    result, status = poser_dispense(etab_id, data, _restriction())
    return jsonify(result), status


@trous_bp.route('/dispense/retirer', methods=['POST'])
def trous_dispense_retirer():
    etab_id, data = _contexte()
    result, status = retirer_dispense(etab_id, data, _restriction())
    return jsonify(result), status
