from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity

from services.emploi_du_temps_services import (
    create_entity_scoped, get_all_entities_scoped, get_entity_scoped,
    update_entity_scoped, delete_entity_scoped,
    create_creneau_scoped, get_all_creneaux_scoped, get_creneau_scoped,
    update_creneau_scoped, delete_creneau_scoped,
)
# Réutilisé pour horaire_bp ci-dessous : un Censeur/Surveillant n'accède
# qu'aux Horaire dont la classe (via matiere_classe_id) lui a été assignée —
# même résolution que pour TitulaireClasse/MatiereClasse (pedagogie_api.py)
# et Classe (structure_api.py). Pas appliqué à creneau_horaire_bp : les
# créneaux (grille horaire type "8h-9h") ne sont pas rattachés à une classe
# précise, ils restent un référentiel établissement-large pour tous les
# rôles qui y ont accès, cf. synthèse d'assignation Censeur/Surveillant ↔ Classe.
from services.pedagogie_services import resolve_classe_ids_restriction


# Accès lecture+écriture, comme Admin : Censeur et Surveillant en ont besoin
# pour consulter/gérer les créneaux et l'emploi du temps de leur établissement
# (pour horaire_bp, restreint aux classes assignées — cf.
# _current_classe_restriction ci-dessous).
ROLES_ACCES_EMPLOI_DU_TEMPS = ("Admin", "SuperAdmin", "Censeur", "Surveillant")


def _resolve_etablissement_id():
    """- Admin d'établissement : toujours celui de son propre compte (claim JWT)
    - SuperAdmin : celui passé en query param, pour consulter un établissement précis
    Utilisé par les deux blueprints ci-dessous (creneau_horaire_bp et horaire_bp),
    tous deux cloisonnés par établissement."""
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        return request.args.get("etablissement_id", type=int)
    return claims.get("etablissement_id")


def _current_classe_restriction():
    """Utilisé UNIQUEMENT par horaire_bp (pas creneau_horaire_bp, cf.
    ci-dessus) : None pour Admin/SuperAdmin (pas de restriction) ; pour un
    Censeur/Surveillant, le set() des classe_id qui lui ont été assignées,
    résolu EN DIRECT depuis son user_id (get_jwt_identity(), toujours
    fiable) — pas depuis un claim 'profil_id' mis en cache dans le JWT à
    l'émission, qui pouvait rester périmé si le profil ou ses classes
    étaient (ré)assignés après coup (cf.
    pedagogie_services.resolve_classe_ids_restriction)."""
    claims = get_jwt()
    return resolve_classe_ids_restriction(claims.get("role"), int(get_jwt_identity()))


# ---------------------------------------------------------------------------
# Blueprint CRENEAUX HORAIRES — cloisonné par etablissement_id
# (chaque établissement gère sa propre grille de créneaux, cf.
# emploi_du_temps_models.py : même logique que horaire_bp ci-dessous et que
# les référentiels pédagogiques dans pedagogie_api.py).
#
# Admin d'établissement limité à son propre établissement (etablissement_id
# pris dans le claim JWT), SuperAdmin devant préciser ?etablissement_id=<id>
# pour consulter un établissement donné.
# ---------------------------------------------------------------------------

creneau_horaire_bp = Blueprint('creneau_horaire_api', __name__, url_prefix='/api/creneaux-horaires')


@creneau_horaire_bp.before_request
@jwt_required()
def _require_role_creneau():
    if get_jwt().get("role") not in ROLES_ACCES_EMPLOI_DU_TEMPS:
        return jsonify({"erreur": "Accès non autorisé"}), 403


@creneau_horaire_bp.route('/', methods=['GET'])
def creneau_get_all():
    etab_id = _resolve_etablissement_id()
    if etab_id is None:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    return jsonify(get_all_creneaux_scoped(etab_id)), 200


@creneau_horaire_bp.route('/', methods=['POST'])
def creneau_create():
    etab_id = _resolve_etablissement_id()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = create_creneau_scoped(request.get_json(), etab_id)
    return jsonify(result), status


@creneau_horaire_bp.route('/<int:id>', methods=['GET'])
def creneau_get_one(id):
    etab_id = _resolve_etablissement_id()
    entity = get_creneau_scoped(id, etab_id) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Créneau horaire non trouvé"}), 404
    return jsonify(entity.to_dict()), 200


@creneau_horaire_bp.route('/<int:id>', methods=['PUT'])
def creneau_update(id):
    etab_id = _resolve_etablissement_id()
    entity = get_creneau_scoped(id, etab_id) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Créneau horaire non trouvé"}), 404
    result, status = update_creneau_scoped(entity, request.get_json(), etab_id)
    return jsonify(result), status


@creneau_horaire_bp.route('/<int:id>', methods=['DELETE'])
def creneau_delete(id):
    etab_id = _resolve_etablissement_id()
    entity = get_creneau_scoped(id, etab_id) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Créneau horaire non trouvé"}), 404
    result, status = delete_creneau_scoped(entity, etab_id)
    return jsonify(result), status


# ---------------------------------------------------------------------------
# Blueprint HORAIRES — cloisonné par etablissement_id, déduit indirectement
# via matiere_classe_id -> MatiereClasse.classe_id -> Classe.etablissement_id
# (cf. emploi_du_temps_services.get_etablissement_id_of). Cloisonnement
# indirect, contrairement à creneau_horaire_bp ci-dessus qui s'appuie sur une
# colonne etablissement_id directe.
#
# Admin d'établissement limité à son propre établissement (etablissement_id
# pris dans le claim JWT), SuperAdmin devant préciser ?etablissement_id=<id>
# pour consulter un établissement donné — même logique que pedagogie_api.py.
#
# NB : contrairement à pedagogie_api.py (POST utilise le corps de la requête
# pour le SuperAdmin), Horaire ne porte pas de colonne etablissement_id : le
# paramètre etablissement_id ne sert ici qu'à valider le contexte (matiere_classe,
# annee_scolaire et désormais creneau_id doivent tous lui appartenir), donc on
# utilise ?etablissement_id= uniformément sur les 4 verbes, y compris POST.
# ---------------------------------------------------------------------------

horaire_bp = Blueprint('horaire_api', __name__, url_prefix='/api/horaires')


@horaire_bp.before_request
@jwt_required()
def _require_role_horaire():
    if get_jwt().get("role") not in ROLES_ACCES_EMPLOI_DU_TEMPS:
        return jsonify({"erreur": "Accès non autorisé"}), 403


@horaire_bp.route('/', methods=['GET'])
def horaire_get_all():
    etab_id = _resolve_etablissement_id()
    if etab_id is None:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    return jsonify(get_all_entities_scoped(etab_id, _current_classe_restriction())), 200


@horaire_bp.route('/', methods=['POST'])
def horaire_create():
    etab_id = _resolve_etablissement_id()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = create_entity_scoped(request.get_json(), etab_id, _current_classe_restriction())
    return jsonify(result), status


@horaire_bp.route('/<int:id>', methods=['GET'])
def horaire_get_one(id):
    etab_id = _resolve_etablissement_id()
    entity = get_entity_scoped(id, etab_id, _current_classe_restriction()) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Horaire non trouvé"}), 404
    return jsonify(entity.to_dict()), 200


@horaire_bp.route('/<int:id>', methods=['PUT'])
def horaire_update(id):
    etab_id = _resolve_etablissement_id()
    entity = get_entity_scoped(id, etab_id, _current_classe_restriction()) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Horaire non trouvé"}), 404
    result, status = update_entity_scoped(entity, request.get_json(), etab_id, _current_classe_restriction())
    return jsonify(result), status


@horaire_bp.route('/<int:id>', methods=['DELETE'])
def horaire_delete(id):
    etab_id = _resolve_etablissement_id()
    entity = get_entity_scoped(id, etab_id, _current_classe_restriction()) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Horaire non trouvé"}), 404
    result, status = delete_entity_scoped(entity, etab_id, _current_classe_restriction())
    return jsonify(result), status