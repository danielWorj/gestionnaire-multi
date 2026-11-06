from flask import Blueprint, request, jsonify, send_from_directory
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity

from services.inscription_services import (
    create_entity_scoped, get_all_entities_scoped, get_entity_scoped,
    update_entity_scoped, delete_entity_scoped,
    save_photo_eleve, delete_photo_eleve, photos_dir_of, chemin_photo_eleve,
)
from models.inscription_models import Parent, Eleve, Inscription
# Réutilisé pour inscription_bp ci-dessous (classe_scoped=True) : un
# Censeur/Surveillant ne consulte QUE les inscriptions des classes qui lui
# ont été assignées — même résolution que pour TitulaireClasse/MatiereClasse
# (pedagogie_api.py), Classe (structure_api.py) et Horaire
# (emploi_du_temps_api.py) — cf. synthèse d'assignation Censeur/Surveillant ↔ Classe.
from services.pedagogie_services import resolve_classe_ids_restriction


# ---------------------------------------------------------------------------
# Blueprint SCOPED — cloisonné par etablissement_id
# (Parent, Eleve, Inscription)
#
# roles_autorises par défaut = Admin/SuperAdmin/Secretaire : la gestion des
# élèves, de leurs parents et de leurs inscriptions est une tâche de
# secrétariat d'établissement (rôle 'Secretaire', cf. Role.init_roles() dans
# authentification_models.py) — ni un Censeur ni un Surveillant n'y ont accès
# en écriture, au même titre que censeur_bp/surveillant_bp dans
# pedagogie_api.py sont réservés à Admin/SuperAdmin.
#
# Admin d'établissement limité à son propre établissement (etablissement_id
# pris dans le claim JWT), SuperAdmin devant préciser ?etablissement_id=<id>
# (GET/PUT/DELETE) ou l'inclure dans le corps de la requête (POST) pour
# consulter/gérer un établissement donné — même logique que
# pedagogie_api.make_pedagogie_scoped_blueprint et
# structure_api.make_scoped_crud_blueprint.
# ---------------------------------------------------------------------------

def make_inscription_scoped_blueprint(name, model, url_prefix,
                                       roles_autorises=("Admin", "SuperAdmin", "Secretaire"),
                                       read_only_roles=(),
                                       classe_scoped=False,
                                       lecture_etablissement_roles=("Comptable",)):
    """lecture_etablissement_roles : rôles n'ayant accès qu'en LECTURE (GET),
    sur TOUT l'établissement (aucune restriction par classe, contrairement à
    read_only_roles). Le Comptable en a besoin pour la page Paiements
    (choix de l'élève payeur, parent, inscriptions actives de chaque classe).

    read_only_roles : rôles supplémentaires qui n'ont accès qu'en LECTURE
    (GET) — jamais en création/modification/suppression. Utilisé UNIQUEMENT
    par inscription_bp ci-dessous (Censeur, Surveillant) : ces rôles peuvent
    consulter la liste des élèves inscrits dans les classes qui leur ont été
    assignées (même besoin que pour horaire_bp : suivre sa classe sans
    pouvoir modifier librement les inscriptions), mais ne peuvent ni
    inscrire, ni radier, ni réassigner un élève — cette responsabilité reste
    au secrétariat/à l'administration. Sans effet pour parent_bp/eleve_bp
    (classe_scoped=False, read_only_roles=() par défaut) : un
    Censeur/Surveillant n'a pas de périmètre "parent" ou "élève" propre,
    uniquement au travers des Inscription de ses classes.

    classe_scoped : True UNIQUEMENT pour inscription_bp — indique que ce
    modèle (colonne classe_id directe) doit être filtré aux classes
    assignées pour les rôles listés dans read_only_roles (cf.
    CenseurClasse/SurveillantClasse et resolve_classe_ids_restriction dans
    pedagogie_services.py). Sans effet pour Admin/SuperAdmin/Secretaire
    (résolu à None, comportement inchangé) ni pour parent_bp/eleve_bp
    (référentiels établissement-larges, non rattachés à une classe)."""
    bp = Blueprint(f'{name}_api', __name__, url_prefix=url_prefix)

    @bp.before_request
    @jwt_required()
    def _require_role():
        role = get_jwt().get("role")
        if role in roles_autorises:
            return
        if (role in read_only_roles or role in lecture_etablissement_roles) and request.method == "GET":
            return
        return jsonify({"erreur": "Accès non autorisé"}), 403

    def _current_etablissement_id():
        """- Admin d'établissement : toujours celui de son propre compte (claim JWT)
        - SuperAdmin : celui passé en query param, pour consulter un établissement précis"""
        claims = get_jwt()
        if claims.get("role") == "SuperAdmin":
            return request.args.get("etablissement_id", type=int)
        return claims.get("etablissement_id")

    def _current_classe_restriction():
        """None si classe_scoped=False, pour Admin/SuperAdmin/Secretaire, ou
        pour tout rôle hors read_only_roles ; sinon (Censeur/Surveillant en
        lecture seule sur inscription_bp) le set() des classe_id assignées,
        résolu EN DIRECT depuis le user_id courant (get_jwt_identity(),
        toujours fiable) — pas depuis un claim 'profil_id' mis en cache dans
        le JWT à l'émission, qui pouvait rester périmé (cf.
        pedagogie_services.resolve_classe_ids_restriction)."""
        if not classe_scoped:
            return None
        claims = get_jwt()
        role = claims.get("role")
        if role not in read_only_roles or role in lecture_etablissement_roles:
            return None
        return resolve_classe_ids_restriction(role, int(get_jwt_identity()))

    @bp.route('/', methods=['GET'])
    def get_all():
        etab_id = _current_etablissement_id()
        if etab_id is None:
            return jsonify({"erreur": "etablissement_id requis"}), 400
        return jsonify(get_all_entities_scoped(model, etab_id, _current_classe_restriction())), 200

    @bp.route('/', methods=['POST'])
    def create():
        claims = get_jwt()
        data = request.get_json(silent=True) or {}
        etab_id = data.get("etablissement_id") if claims.get("role") == "SuperAdmin" \
            else claims.get("etablissement_id")
        if not etab_id:
            return jsonify({"erreur": "etablissement_id requis"}), 400
        result, status = create_entity_scoped(model, data, etab_id, _current_classe_restriction())
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
        result, status = update_entity_scoped(entity, request.get_json(silent=True) or {}, etab_id,
                                              _current_classe_restriction())
        return jsonify(result), status

    @bp.route('/<int:id>', methods=['DELETE'])
    def delete(id):
        etab_id = _current_etablissement_id()
        entity = get_entity_scoped(model, id, etab_id, _current_classe_restriction()) if etab_id else None
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        result, status = delete_entity_scoped(entity, etab_id, _current_classe_restriction())
        return jsonify(result), status

    if model is Eleve:
        # -------------------------------------------------------------------
        # Photo d'identité (fiche élève, en-tête du bulletin), en
        # multipart/form-data (champ « photo »), séparée du CRUD JSON pour ne
        # pas toucher à la file hors connexion. Mêmes rôles et même
        # cloisonnement que le reste de eleve_bp ; le Comptable (lecture
        # seule) peut la voir mais pas la modifier (cf. _require_role). Pour
        # le Censeur/Surveillant, cf. bulletin_api.bulletin_photo_eleve.
        # -------------------------------------------------------------------

        def _eleve_courant(id):
            etab_id = _current_etablissement_id()
            return get_entity_scoped(Eleve, id, etab_id) if etab_id else None

        @bp.route('/<int:id>/photo', methods=['GET'])
        def get_photo(id):
            eleve = _eleve_courant(id)
            if not chemin_photo_eleve(eleve):
                return jsonify({"erreur": "Photo non trouvée"}), 404
            return send_photo_eleve(eleve)

        @bp.route('/<int:id>/photo', methods=['POST', 'PUT'])
        def upload_photo(id):
            eleve = _eleve_courant(id)
            if not eleve:
                return jsonify({"erreur": "eleve non trouvé"}), 404
            result, status = save_photo_eleve(eleve, request.files.get('photo'))
            return jsonify(result), status

        @bp.route('/<int:id>/photo', methods=['DELETE'])
        def remove_photo(id):
            eleve = _eleve_courant(id)
            if not eleve:
                return jsonify({"erreur": "eleve non trouvé"}), 404
            result, status = delete_photo_eleve(eleve)
            return jsonify(result), status

    return bp


def send_photo_eleve(eleve):
    """Sert la photo d'un élève DÉJÀ autorisé par l'appelant. Cache privé
    seulement (jamais par un proxy partagé) ; l'URL change à chaque upload."""
    response = send_from_directory(photos_dir_of(eleve.etablissement_id), eleve.photo)
    response.headers['Cache-Control'] = 'private, max-age=86400'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


# ---------------------------------------------------------------------------
# Enregistrement des blueprints
# ---------------------------------------------------------------------------

parent_bp = make_inscription_scoped_blueprint('parent', Parent, '/api/parents')
eleve_bp = make_inscription_scoped_blueprint('eleve', Eleve, '/api/eleves')

# classe_scoped=True + read_only_roles=("Censeur", "Surveillant") : ces deux
# rôles peuvent consulter (GET uniquement) les inscriptions des classes qui
# leur ont été assignées, mais ne peuvent ni inscrire, ni radier, ni
# réassigner un élève (réservé à Admin/SuperAdmin/Secretaire) — cf.
# docstring de make_inscription_scoped_blueprint ci-dessus.
inscription_bp = make_inscription_scoped_blueprint(
    'inscription', Inscription, '/api/inscriptions',
    read_only_roles=("Censeur", "Surveillant"),
    classe_scoped=True,
)

# ---------------------------------------------------------------------------
# Dossier d'inscription : parent + élève + inscription en une transaction
# (saisie hors connexion notamment), avec détection des doublons — cf.
# services/dossier_inscription_services.py. Mêmes rôles que la création
# d'une inscription (Admin, SuperAdmin, Secretaire).
# ---------------------------------------------------------------------------

from services.dossier_inscription_services import enregistrer_dossier  # noqa: E402

ROLES_DOSSIER = ("Admin", "SuperAdmin", "Secretaire")

dossier_inscription_bp = Blueprint('dossier_inscription_api', __name__, url_prefix='/api/dossiers-inscription')


@dossier_inscription_bp.before_request
@jwt_required()
def _require_role_dossier():
    if get_jwt().get("role") not in ROLES_DOSSIER:
        return jsonify({"erreur": "Accès non autorisé"}), 403
    return None


@dossier_inscription_bp.route('/', methods=['POST'])
def dossier_create():
    claims = get_jwt()
    data = request.get_json(silent=True) or {}
    etab_id = data.get("etablissement_id") if claims.get("role") == "SuperAdmin" else claims.get("etablissement_id")
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = enregistrer_dossier(data, int(etab_id))
    return jsonify(result), status
