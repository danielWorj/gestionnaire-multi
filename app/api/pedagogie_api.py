from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt

from api.structure_api import make_admin_crud_blueprint
from services.pedagogie_services import (
    create_entity_scoped, get_all_entities_scoped, get_entity_scoped,
    update_entity_scoped, delete_entity_scoped,
)
from models.pedagogie_models import (
    GroupeMatiere, Matiere, Enseignant, TitulaireClasse, MatiereClasse
)


# ---------------------------------------------------------------------------
# Blueprints ADMIN — référentiel global, réservé au SuperAdmin, non cloisonné
# (GroupeMatiere, Matiere — cf. pedagogie_models.py)
#
# make_admin_crud_blueprint (structure_api.py, utilisé pour Etablissement)
# est déjà 100% générique : on la réutilise telle quelle plutôt que de la
# dupliquer.
# ---------------------------------------------------------------------------

groupe_matiere_bp = make_admin_crud_blueprint('groupe_matiere', GroupeMatiere, '/api/groupes-matieres')
matiere_bp = make_admin_crud_blueprint('matiere', Matiere, '/api/matieres')


# ---------------------------------------------------------------------------
# Blueprint SCOPED — cloisonné par etablissement_id
# (Enseignant, TitulaireClasse, MatiereClasse)
#
# Même politique d'accès que structure_api.make_scoped_crud_blueprint (Admin
# d'établissement limité à son propre établissement, SuperAdmin devant
# préciser ?etablissement_id=<id>), mais appuyée sur
# services/pedagogie_services.py puisque les modèles cloisonnés et les
# règles de validation des clés étrangères diffèrent de ceux de structure.
# ---------------------------------------------------------------------------

def make_pedagogie_scoped_blueprint(name, model, url_prefix):
    bp = Blueprint(f'{name}_api', __name__, url_prefix=url_prefix)

    @bp.before_request
    @jwt_required()
    def _require_role():
        if get_jwt().get("role") not in ("Admin", "SuperAdmin"):
            return jsonify({"erreur": "Accès non autorisé"}), 403

    def _current_etablissement_id():
        """- Admin d'établissement : toujours celui de son propre compte (claim JWT)
        - SuperAdmin : celui passé en query param, pour consulter un établissement précis"""
        claims = get_jwt()
        if claims.get("role") == "SuperAdmin":
            return request.args.get("etablissement_id", type=int)
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

enseignant_bp = make_pedagogie_scoped_blueprint('enseignant', Enseignant, '/api/enseignants')
titulaire_classe_bp = make_pedagogie_scoped_blueprint('titulaire_classe', TitulaireClasse, '/api/titulaires-classe')
matiere_classe_bp = make_pedagogie_scoped_blueprint('matiere_classe', MatiereClasse, '/api/matieres-classe')