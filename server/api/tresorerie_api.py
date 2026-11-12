from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from api.paiements_api import ROLES_ACCES_PAIEMENTS, _current_etablissement_id, _etablissement_id_pour_creation
from services.tresorerie_services import (
    annuler_mouvement, create_categorie, create_compte, create_mouvement, delete_categorie, delete_compte,
    get_categorie, get_categories, get_compte, get_comptes, get_journal, get_mouvement, get_synthese,
    update_categorie, update_compte, update_mouvement,
)

# ---------------------------------------------------------------------------
# Trésorerie (cf. services/tresorerie_services.py) : mêmes rôles et même
# cloisonnement par établissement que les paiements (Admin, SuperAdmin,
# Comptable ; le SuperAdmin précise ?etablissement_id= ou le met dans le
# corps des POST).
#
#   /api/tresorerie/categories   GET ?type= | POST | PUT/DELETE /<id>
#   /api/tresorerie/comptes      GET | POST | PUT/DELETE /<id>
#   /api/tresorerie/mouvements   POST | GET/PUT /<id> | POST /<id>/annuler
#   /api/tresorerie/journal      GET ?du&au&sens&categorie_id&compte_id
#   /api/tresorerie/synthese     GET ?du&au
#
# Aucun DELETE sur les mouvements : une opération s'annule (motif), le
# journal d'audit garde qui a fait quoi.
# ---------------------------------------------------------------------------

tresorerie_bp = Blueprint('tresorerie_api', __name__, url_prefix='/api/tresorerie')


@tresorerie_bp.before_request
@jwt_required()
def _require_role():
    if get_jwt().get("role") not in ROLES_ACCES_PAIEMENTS:
        return jsonify({"erreur": "Accès non autorisé"}), 403


def _etab_lecture():
    etab_id = _current_etablissement_id()
    if not etab_id:
        return None, (jsonify({"erreur": "etablissement_id requis"}), 400)
    return etab_id, None


def _corps():
    return request.get_json(silent=True) or {}


# ── Catégories ─────────────────────────────────────────────────────────────

@tresorerie_bp.route('/categories', methods=['GET'])
def categories_liste():
    etab_id, err = _etab_lecture()
    if err:
        return err
    return jsonify(get_categories(etab_id, request.args.get('type'))), 200


@tresorerie_bp.route('/categories', methods=['POST'])
def categories_creer():
    etab_id = _etablissement_id_pour_creation()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = create_categorie(_corps(), etab_id)
    return jsonify(result), status


@tresorerie_bp.route('/categories/<int:id>', methods=['PUT', 'DELETE'])
def categories_une(id):
    etab_id, err = _etab_lecture()
    if err:
        return err
    categorie = get_categorie(id, etab_id)
    if not categorie:
        return jsonify({"erreur": "Catégorie non trouvée"}), 404
    result, status = (update_categorie(categorie, _corps()) if request.method == 'PUT'
                      else delete_categorie(categorie))
    return jsonify(result), status


# ── Comptes ────────────────────────────────────────────────────────────────

@tresorerie_bp.route('/comptes', methods=['GET'])
def comptes_liste():
    etab_id, err = _etab_lecture()
    if err:
        return err
    return jsonify(get_comptes(etab_id)), 200


@tresorerie_bp.route('/comptes', methods=['POST'])
def comptes_creer():
    etab_id = _etablissement_id_pour_creation()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = create_compte(_corps(), etab_id)
    return jsonify(result), status


@tresorerie_bp.route('/comptes/<int:id>', methods=['PUT', 'DELETE'])
def comptes_un(id):
    etab_id, err = _etab_lecture()
    if err:
        return err
    compte = get_compte(id, etab_id)
    if not compte:
        return jsonify({"erreur": "Compte non trouvé"}), 404
    result, status = update_compte(compte, _corps()) if request.method == 'PUT' else delete_compte(compte)
    return jsonify(result), status


# ── Mouvements ─────────────────────────────────────────────────────────────

@tresorerie_bp.route('/mouvements', methods=['POST'])
def mouvements_creer():
    # Comme pour l'encaissement d'un paiement : l'auteur est le compte
    # connecté, jamais une valeur du payload ; le SuperAdmin (hors table
    # utilisateur) ne saisit pas d'opération.
    if get_jwt().get("role") == "SuperAdmin":
        return jsonify({"erreur": "Le SuperAdmin ne peut pas saisir d'opération de trésorerie : "
                                  "connectez-vous avec un compte Comptable ou Admin de l'établissement"}), 403
    etab_id = _etablissement_id_pour_creation()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = create_mouvement(_corps(), etab_id, int(get_jwt_identity()))
    return jsonify(result), status


@tresorerie_bp.route('/mouvements/<int:id>', methods=['GET', 'PUT'])
def mouvements_un(id):
    etab_id, err = _etab_lecture()
    if err:
        return err
    mouvement = get_mouvement(id, etab_id)
    if not mouvement:
        return jsonify({"erreur": "Opération non trouvée"}), 404
    if request.method == 'GET':
        return jsonify(mouvement.to_dict()), 200
    result, status = update_mouvement(mouvement, _corps())
    return jsonify(result), status


@tresorerie_bp.route('/mouvements/<int:id>/annuler', methods=['POST'])
def mouvements_annuler(id):
    etab_id, err = _etab_lecture()
    if err:
        return err
    mouvement = get_mouvement(id, etab_id)
    if not mouvement:
        return jsonify({"erreur": "Opération non trouvée"}), 404
    result, status = annuler_mouvement(mouvement, _corps().get('motif_annulation'))
    return jsonify(result), status


# ── États ──────────────────────────────────────────────────────────────────

@tresorerie_bp.route('/journal', methods=['GET'])
def journal():
    etab_id, err = _etab_lecture()
    if err:
        return err
    result, status = get_journal(
        etab_id, du=request.args.get('du'), au=request.args.get('au'), sens=request.args.get('sens') or None,
        categorie_id=request.args.get('categorie_id', type=int),
        compte_id=request.args.get('compte_id', type=int),
    )
    return jsonify(result), status


@tresorerie_bp.route('/synthese', methods=['GET'])
def synthese():
    etab_id, err = _etab_lecture()
    if err:
        return err
    result, status = get_synthese(etab_id, du=request.args.get('du'), au=request.args.get('au'))
    return jsonify(result), status
