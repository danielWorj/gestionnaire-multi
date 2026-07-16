from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt

from services.structure_services import (
    create_entity, get_all_entities, get_entity_by_id, update_entity, delete_entity,
    create_entity_scoped, get_all_entities_scoped, get_entity_scoped,
    update_entity_scoped, delete_entity_scoped,
)
from models.structure_models import (
    Etablissement, Cycle, Classe, AnneeScolaire, Trimestre, Sequence
)


# ---------------------------------------------------------------------------
# Blueprint ADMIN — réservé à l'administrateur, non cloisonné
# (utilisé uniquement pour Etablissement)
# ---------------------------------------------------------------------------

def make_admin_crud_blueprint(name, model, url_prefix):
    bp = Blueprint(f'{name}_api', __name__, url_prefix=url_prefix)

    @bp.before_request
    @jwt_required()
    def _require_admin():
        # Etablissement est géré par le SuperAdmin (compte global, hors établissement) —
        # cf. authentification_models.py / _build_superadmin_claims : role='SuperAdmin'.
        # (Corrigé : l'ancien check role=='Admin' visait le rôle d'établissement,
        # qui n'a jamais accès à Etablissement.)
        if get_jwt().get("role") != "SuperAdmin":
            return jsonify({"erreur": "Accès réservé au SuperAdmin"}), 403

    @bp.route('/', methods=['GET'])
    def get_all():
        return jsonify(get_all_entities(model)), 200

    @bp.route('/', methods=['POST'])
    def create():
        data = request.get_json()
        result, status = create_entity(model, data)
        return jsonify(result), status

    @bp.route('/<int:id>', methods=['GET'])
    def get_one(id):
        entity = get_entity_by_id(model, id)
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        return jsonify(entity.to_dict()), 200

    @bp.route('/<int:id>', methods=['PUT'])
    def update(id):
        entity = get_entity_by_id(model, id)
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        result, status = update_entity(entity, request.get_json())
        return jsonify(result), status

    @bp.route('/<int:id>', methods=['DELETE'])
    def delete(id):
        entity = get_entity_by_id(model, id)
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        result, status = delete_entity(entity)
        return jsonify(result), status

    return bp


# ---------------------------------------------------------------------------
# Blueprint SCOPED — gestionnaire d'établissement, cloisonné par etablissement_id
# (Cycle, Classe, AnneeScolaire, Trimestre, Sequence)
# L'admin peut aussi y accéder, mais doit préciser ?etablissement_id=<id>
# ---------------------------------------------------------------------------

def make_scoped_crud_blueprint(name, model, url_prefix):
    bp = Blueprint(f'{name}_api', __name__, url_prefix=url_prefix)

    @bp.before_request
    @jwt_required()
    def _require_role():
        # Libellés alignés sur authentification_models.Role.init_roles() : le rôle
        # d'établissement est désormais 'Admin' (ex-'GestionnaireEtablissement').
        # 'SuperAdmin' garde un accès de consultation/administration transverse.
        if get_jwt().get("role") not in ("Admin", "SuperAdmin"):
            return jsonify({"erreur": "Accès non autorisé"}), 403

    def _current_etablissement_id():
        """Détermine l'etablissement_id de contexte :
        - Admin d'établissement : toujours celui de son propre compte (claim JWT)
        - SuperAdmin : celui passé en query param, pour consulter un établissement précis
        """
        claims = get_jwt()
        if claims.get("role") == "SuperAdmin":
            etab_id = request.args.get("etablissement_id", type=int)
            return etab_id  # peut être None -> traité par l'appelant
        return claims.get("etablissement_id")

    @bp.route('/', methods=['GET'])
    def get_all():
        etab_id = _current_etablissement_id()
        if etab_id is None:
            return jsonify({"erreur": "etablissement_id requis"}), 400
        return jsonify(get_all_entities_scoped(model, etab_id)), 200

    @bp.route('/', methods=['POST'])
    def create():
        claims = get_jwt()
        etab_id = request.get_json().get("etablissement_id") if claims.get("role") == "SuperAdmin" \
            else claims.get("etablissement_id")
        if not etab_id:
            return jsonify({"erreur": "etablissement_id requis"}), 400
        result, status = create_entity_scoped(model, request.get_json(), etab_id)
        return jsonify(result), status

    @bp.route('/<int:id>', methods=['GET'])
    def get_one(id):
        etab_id = _current_etablissement_id()
        entity = get_entity_scoped(model, id, etab_id) if etab_id else None
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        return jsonify(entity.to_dict()), 200

    @bp.route('/<int:id>', methods=['PUT'])
    def update(id):
        etab_id = _current_etablissement_id()
        entity = get_entity_scoped(model, id, etab_id) if etab_id else None
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        result, status = update_entity_scoped(entity, request.get_json(), etab_id)
        return jsonify(result), status

    @bp.route('/<int:id>', methods=['DELETE'])
    def delete(id):
        etab_id = _current_etablissement_id()
        entity = get_entity_scoped(model, id, etab_id) if etab_id else None
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        result, status = delete_entity_scoped(entity, etab_id)
        return jsonify(result), status

    return bp


# ---------------------------------------------------------------------------
# Enregistrement des blueprints
# ---------------------------------------------------------------------------

etablissement_bp = make_admin_crud_blueprint('etablissement', Etablissement, '/api/etablissements')

cycle_bp = make_scoped_crud_blueprint('cycle', Cycle, '/api/cycles')
classe_bp = make_scoped_crud_blueprint('classe', Classe, '/api/classes')
annee_scolaire_bp = make_scoped_crud_blueprint('annee_scolaire', AnneeScolaire, '/api/annees-scolaires')
trimestre_bp = make_scoped_crud_blueprint('trimestre', Trimestre, '/api/trimestres')
sequence_bp = make_scoped_crud_blueprint('sequence', Sequence, '/api/sequences')