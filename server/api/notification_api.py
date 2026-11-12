from flask import Blueprint, jsonify
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from services.notification_services import (
    assurer_generation, echeances_saisie, lister, marquer_lue, tout_marquer_lu,
)


# ---------------------------------------------------------------------------
# Notifications de l'utilisateur connecté, pour son RÔLE ACTIF (un compte
# multi-rôles ne voit dans un espace que les notifications de cet espace).
#   GET  /api/notifications/                  -> {notifications, non_lues}
#   POST /api/notifications/<id>/lue
#   POST /api/notifications/tout-lire
#   GET  /api/notifications/echeances-saisie  -> {sequences: [{id, libelle, date_fin}]}
# Le SuperAdmin (compte hors établissement) n'en reçoit pas : liste vide.
# ---------------------------------------------------------------------------

notification_bp = Blueprint('notification_api', __name__, url_prefix='/api/notifications')


@notification_bp.before_request
@jwt_required()
def _require_compte():
    return None


def _destinataire():
    """(utilisateur_id, rôle actif, etablissement_id), ou None pour un
    SuperAdmin."""
    claims = get_jwt()
    if claims.get("type_compte") != "utilisateur":
        return None
    return int(get_jwt_identity()), claims.get("role"), claims.get("etablissement_id")


@notification_bp.route('/', methods=['GET'])
def notifications():
    dest = _destinataire()
    if dest is None:
        return jsonify({"notifications": [], "non_lues": 0}), 200
    utilisateur_id, role, etab_id = dest
    assurer_generation(etab_id)
    return jsonify(lister(utilisateur_id, role)), 200


@notification_bp.route('/<int:notification_id>/lue', methods=['POST'])
def notification_lue(notification_id):
    dest = _destinataire()
    if dest is None:
        return jsonify({"erreur": "Notification introuvable"}), 404
    resultat, status = marquer_lue(dest[0], dest[1], notification_id)
    return jsonify(resultat), status


@notification_bp.route('/tout-lire', methods=['POST'])
def notifications_tout_lire():
    dest = _destinataire()
    if dest is None:
        return jsonify({"marquees": 0}), 200
    resultat, status = tout_marquer_lu(dest[0], dest[1])
    return jsonify(resultat), status


@notification_bp.route('/echeances-saisie', methods=['GET'])
def notifications_echeances_saisie():
    dest = _destinataire()
    return jsonify(echeances_saisie(dest[2] if dest else None)), 200
