from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity

from services.pedagogie_services import (
    create_entity_scoped, get_all_entities_scoped, get_entity_scoped,
    update_entity_scoped, delete_entity_scoped, resolve_classe_ids_restriction,
    create_censeur_avec_compte, create_surveillant_avec_compte,
)
from models.pedagogie_models import (
    GroupeMatiere, Matiere, Enseignant, TitulaireClasse, MatiereClasse,
    Departement, Grade, Censeur, Surveillant, CenseurClasse, SurveillantClasse
)


# ---------------------------------------------------------------------------
# Blueprint SCOPED — cloisonné par etablissement_id
# (GroupeMatiere, Matiere, Enseignant, TitulaireClasse, MatiereClasse)
#
# Admin d'établissement limité à son propre établissement (etablissement_id
# pris dans le claim JWT), SuperAdmin devant préciser ?etablissement_id=<id>
# pour consulter un établissement donné. Appuyé sur
# services/pedagogie_services.py puisque les règles de validation des clés
# étrangères diffèrent de celles de structure_api.make_scoped_crud_blueprint.
# ---------------------------------------------------------------------------

def make_pedagogie_scoped_blueprint(name, model, url_prefix,
                                     roles_autorises=("Admin", "SuperAdmin", "Censeur", "Surveillant"),
                                     classe_scoped=False):
    """roles_autorises : par défaut ouvert en lecture+écriture à Admin, SuperAdmin,
    Censeur et Surveillant (référentiels pédagogiques : matières, enseignants,
    classes-matières...). Les blueprints censeur_bp/surveillant_bp/
    censeur_classe_bp/surveillant_classe_bp ci-dessous surchargent ce
    paramètre pour rester réservés à Admin/SuperAdmin : un Censeur ou un
    Surveillant ne doit pas pouvoir créer/gérer les comptes de ses pairs, ni
    s'auto-assigner une classe — seul l'Admin d'établissement (ou le
    SuperAdmin) le peut.

    classe_scoped : True UNIQUEMENT pour titulaire_classe_bp et
    matiere_classe_bp ci-dessous — modèles rattachés à une classe précise
    (colonne classe_id) pour lesquels un Censeur/Surveillant n'accède qu'au
    sous-ensemble de classes qui lui a été assigné (cf. CenseurClasse/
    SurveillantClasse et resolve_classe_ids_restriction dans
    pedagogie_services.py). Sans effet pour Admin/SuperAdmin (résolu à None,
    donc comportement inchangé), ni pour les référentiels globaux
    (GroupeMatiere, Matiere, Departement, Grade, Enseignant, Censeur,
    Surveillant, CenseurClasse, SurveillantClasse) qui restent cloisonnés par
    établissement uniquement, comme avant — cf. synthèse d'assignation
    Censeur/Surveillant ↔ Classe."""
    bp = Blueprint(f'{name}_api', __name__, url_prefix=url_prefix)

    @bp.before_request
    @jwt_required()
    def _require_role():
        if get_jwt().get("role") not in roles_autorises:
            return jsonify({"erreur": "Accès non autorisé"}), 403

    def _current_etablissement_id():
        """- Admin d'établissement : toujours celui de son propre compte (claim JWT)
        - SuperAdmin : celui passé en query param, pour consulter un établissement précis"""
        claims = get_jwt()
        if claims.get("role") == "SuperAdmin":
            return request.args.get("etablissement_id", type=int)
        return claims.get("etablissement_id")

    def _current_classe_restriction():
        """None si classe_scoped=False (référentiels globaux) ou pour
        Admin/SuperAdmin ; sinon le set() des classe_id assignées au
        Censeur/Surveillant connecté, résolu EN DIRECT depuis son user_id
        (get_jwt_identity(), toujours fiable) — pas depuis un claim
        'profil_id' mis en cache dans le JWT à l'émission, qui pouvait
        rester périmé (cf. pedagogie_services.resolve_classe_ids_restriction)."""
        if not classe_scoped:
            return None
        claims = get_jwt()
        return resolve_classe_ids_restriction(claims.get("role"), int(get_jwt_identity()))

    @bp.route('/', methods=['GET'])
    def get_all():
        etab_id = _current_etablissement_id()
        if etab_id is None:
            return jsonify({"erreur": "etablissement_id requis"}), 400
        return jsonify(get_all_entities_scoped(model, etab_id, _current_classe_restriction())), 200

    @bp.route('/', methods=['POST'])
    def create():
        claims = get_jwt()
        etab_id = request.get_json().get("etablissement_id") if claims.get("role") == "SuperAdmin" \
            else claims.get("etablissement_id")
        if not etab_id:
            return jsonify({"erreur": "etablissement_id requis"}), 400
        result, status = create_entity_scoped(model, request.get_json(), etab_id, _current_classe_restriction())
        return jsonify(result), status

    @bp.route('/<int:id>', methods=['GET'])
    def get_one(id):
        etab_id = _current_etablissement_id()
        entity = get_entity_scoped(model, id, etab_id, _current_classe_restriction()) if etab_id else None
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        return jsonify(entity.to_dict()), 200

    @bp.route('/<int:id>', methods=['PUT'])
    def update(id):
        etab_id = _current_etablissement_id()
        entity = get_entity_scoped(model, id, etab_id, _current_classe_restriction()) if etab_id else None
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        result, status = update_entity_scoped(entity, request.get_json(), etab_id, _current_classe_restriction())
        return jsonify(result), status

    @bp.route('/<int:id>', methods=['DELETE'])
    def delete(id):
        etab_id = _current_etablissement_id()
        entity = get_entity_scoped(model, id, etab_id, _current_classe_restriction()) if etab_id else None
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        result, status = delete_entity_scoped(entity, etab_id, _current_classe_restriction())
        return jsonify(result), status

    return bp


# ---------------------------------------------------------------------------
# Enregistrement des blueprints
# ---------------------------------------------------------------------------

groupe_matiere_bp = make_pedagogie_scoped_blueprint('groupe_matiere', GroupeMatiere, '/api/groupes-matieres')
matiere_bp = make_pedagogie_scoped_blueprint('matiere', Matiere, '/api/matieres')
departement_bp = make_pedagogie_scoped_blueprint('departement', Departement, '/api/departements')
grade_bp = make_pedagogie_scoped_blueprint('grade', Grade, '/api/grades')
enseignant_bp = make_pedagogie_scoped_blueprint('enseignant', Enseignant, '/api/enseignants')

# classe_scoped=True : un Censeur/Surveillant n'accède qu'aux classes qui lui
# ont été assignées (cf. CenseurClasse/SurveillantClasse plus bas) — avant
# l'introduction de ce mécanisme, ces deux blueprints étaient ouverts à tout
# l'établissement pour ces deux rôles, au même titre qu'Admin/SuperAdmin.
titulaire_classe_bp = make_pedagogie_scoped_blueprint(
    'titulaire_classe', TitulaireClasse, '/api/titulaires-classe', classe_scoped=True
)
matiere_classe_bp = make_pedagogie_scoped_blueprint(
    'matiere_classe', MatiereClasse, '/api/matieres-classe', classe_scoped=True
)

# Gestion des profils Censeur/Surveillant : réservée à l'Admin d'établissement
# (et au SuperAdmin), contrairement aux blueprints référentiels ci-dessus —
# un Censeur/Surveillant ne doit pas pouvoir créer ou modifier ces profils,
# y compris le sien ou celui d'un pair.
censeur_bp = make_pedagogie_scoped_blueprint(
    'censeur', Censeur, '/api/censeurs', roles_autorises=("Admin", "SuperAdmin")
)
surveillant_bp = make_pedagogie_scoped_blueprint(
    'surveillant', Surveillant, '/api/surveillants', roles_autorises=("Admin", "SuperAdmin")
)


# ---------------------------------------------------------------------------
# Création composite : profil (Censeur/Surveillant) + compte de connexion,
# en une seule requête — remplace le workflow manuel en 3 étapes (créer le
# profil, créer l'Utilisateur, les relier via PUT). Réservé à Admin/
# SuperAdmin, comme censeur_bp/surveillant_bp ci-dessus (même
# before_request, ajouté sur le même objet Blueprint). Body attendu :
# {nom, prenom, email, telephone?, sexe?, classe_ids?: [int]}.
# ---------------------------------------------------------------------------

def _etablissement_id_pour_creation(claims):
    """Même résolution que create() dans make_pedagogie_scoped_blueprint :
    SuperAdmin doit préciser etablissement_id dans le corps de la requête,
    l'Admin d'établissement utilise toujours le sien (claim JWT)."""
    if claims.get("role") == "SuperAdmin":
        return (request.get_json(silent=True) or {}).get("etablissement_id")
    return claims.get("etablissement_id")


@censeur_bp.route('/creer-avec-compte', methods=['POST'])
def censeur_creer_avec_compte():
    etab_id = _etablissement_id_pour_creation(get_jwt())
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = create_censeur_avec_compte(request.get_json(silent=True), etab_id)
    return jsonify(result), status


@surveillant_bp.route('/creer-avec-compte', methods=['POST'])
def surveillant_creer_avec_compte():
    etab_id = _etablissement_id_pour_creation(get_jwt())
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = create_surveillant_avec_compte(request.get_json(silent=True), etab_id)
    return jsonify(result), status

# ---------------------------------------------------------------------------
# Assignation Censeur/Surveillant ↔ Classe — réservée à l'Admin d'établissement
# (et au SuperAdmin) sur TOUS les verbes, y compris la lecture : ni le
# Censeur ni le Surveillant ne peuvent s'auto-assigner une classe, ni même
# consulter la table d'assignation brute — ils découvrent leur périmètre
# via les endpoints déjà filtrés ci-dessus (classe_scoped=True) ainsi que
# /api/classes/ (structure_api.py) et /api/horaires/ (emploi_du_temps_api.py).
# classe_scoped reste à False (par défaut) : ces deux blueprints ne sont de
# toute façon jamais atteints par un Censeur/Surveillant (before_request les
# bloque avant), donc aucune restriction supplémentaire n'est nécessaire ici.
# ---------------------------------------------------------------------------
censeur_classe_bp = make_pedagogie_scoped_blueprint(
    'censeur_classe', CenseurClasse, '/api/censeurs-classes', roles_autorises=("Admin", "SuperAdmin")
)
surveillant_classe_bp = make_pedagogie_scoped_blueprint(
    'surveillant_classe', SurveillantClasse, '/api/surveillants-classes', roles_autorises=("Admin", "SuperAdmin")
)