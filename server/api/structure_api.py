from flask import Blueprint, request, jsonify, send_from_directory
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity

from services.structure_services import (
    create_entity, get_all_entities, get_entity_by_id, update_entity, delete_entity,
    create_entity_scoped, get_all_entities_scoped, get_entity_scoped,
    update_entity_scoped, delete_entity_scoped,
    create_etablissement, update_etablissement, LOGOS_DIR,
)
from models.structure_models import (
    Etablissement, Cycle, Classe, AnneeScolaire, Trimestre, Sequence
)
# Réutilisé pour classe_bp ci-dessous (classe_scoped_self=True) : un
# Censeur/Surveillant n'accède qu'aux classes qui lui ont été assignées,
# même logique et même résolution que pour TitulaireClasse/MatiereClasse
# dans pedagogie_api.py / Horaire dans emploi_du_temps_api.py — cf. synthèse
# d'assignation Censeur/Surveillant ↔ Classe.
from services.pedagogie_services import resolve_classe_ids_restriction


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
        #
        # Exception en LECTURE SEULE : un Admin, un Censeur ou un Surveillant
        # d'établissement peuvent consulter (GET) sa PROPRE fiche établissement
        # (nom, logo_url, adresse...) — c'est ce qui alimente dynamiquement
        # l'en-tête des documents imprimés (cf. horaire.html /
        # infosEtablissementImpression, et horaire_censeur.html / loadEtablissement
        # pour Censeur/Surveillant). Aucun de ces rôles ne peut créer, modifier,
        # supprimer, ni consulter un AUTRE établissement que le sien : la
        # restriction à son propre etablissement_id est appliquée plus bas, dans
        # get_all()/get_one() (le before_request ne fait que laisser passer le verbe).
        # Le Comptable y a aussi accès en lecture : l'en-tête (nom, logo,
        # adresse) des rapports financiers imprimés vient de cette fiche.
        claims = get_jwt()
        if claims.get("role") == "SuperAdmin":
            return
        if claims.get("role") in ("Admin", "Censeur", "Surveillant", "Comptable") and request.method == "GET":
            return
        return jsonify({"erreur": "Accès réservé au SuperAdmin"}), 403

    @bp.route('/', methods=['GET'])
    def get_all():
        # Lister TOUS les établissements de la plateforme reste réservé au
        # SuperAdmin — un Admin d'établissement n'a besoin que du sien, via
        # get_one ci-dessous (avec son propre id).
        if get_jwt().get("role") != "SuperAdmin":
            return jsonify({"erreur": "Accès réservé au SuperAdmin"}), 403
        return jsonify(get_all_entities(model)), 200

    @bp.route('/', methods=['POST'])
    def create():
        if model is Etablissement:
            # multipart/form-data : les champs texte arrivent dans request.form,
            # le fichier logo (optionnel) dans request.files.
            data = request.form.to_dict()
            logo_file = request.files.get('logo')
            result, status = create_etablissement(data, logo_file)
        else:
            result, status = create_entity(model, request.get_json(silent=True) or {})
        return jsonify(result), status

    @bp.route('/<int:id>', methods=['GET'])
    def get_one(id):
        claims = get_jwt()
        # Un Admin d'établissement ne peut consulter que SA PROPRE fiche
        # établissement (claim etablissement_id du JWT) — jamais celle d'un autre
        # établissement, même en devinant son id.
        if claims.get("role") != "SuperAdmin" and id != claims.get("etablissement_id"):
            return jsonify({"erreur": "Accès non autorisé à cette ressource"}), 403
        entity = get_entity_by_id(model, id)
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        return jsonify(entity.to_dict()), 200

    @bp.route('/<int:id>', methods=['PUT'])
    def update(id):
        entity = get_entity_by_id(model, id)
        if not entity:
            return jsonify({"erreur": f"{name} non trouvé"}), 404
        if model is Etablissement:
            data = request.form.to_dict()
            logo_file = request.files.get('logo')
            result, status = update_etablissement(entity, data, logo_file)
        else:
            result, status = update_entity(entity, request.get_json(silent=True) or {})
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

ROLES_ECRITURE_STRUCTURE = ("Admin", "SuperAdmin")


def make_scoped_crud_blueprint(name, model, url_prefix,
                                roles_autorises=("Admin", "SuperAdmin", "Censeur", "Surveillant"),
                                roles_ecriture=ROLES_ECRITURE_STRUCTURE,
                                classe_scoped_self=False,
                                lecture_etablissement_roles=()):
    """roles_autorises : rôles ayant accès en LECTURE. roles_ecriture : seuls
    rôles autorisés à créer/modifier/supprimer (POST/PUT/DELETE) — l'Admin
    d'établissement et le SuperAdmin : un Censeur/Surveillant consulte la
    structure (années, trimestres, séquences, ses classes) mais ne peut ni
    supprimer une année ni renommer/supprimer une classe.

    lecture_etablissement_roles : rôles supplémentaires n'ayant accès
    qu'en LECTURE (GET), sur TOUT l'établissement (aucune restriction par
    classe). Utilisé pour le Comptable (page Paiements) et le Secrétaire
    (pages Élèves / Parents / Inscriptions) sur cycle_bp, classe_bp et
    annee_scolaire_bp.

    classe_scoped_self : True UNIQUEMENT pour classe_bp — indique que CE
    modèle lui-même (Classe, pas une clé étrangère classe_id comme pour
    TitulaireClasse/MatiereClasse dans pedagogie_api.py) doit être filtré aux
    classes assignées pour un Censeur/Surveillant (cf. CenseurClasse/
    SurveillantClasse et resolve_classe_ids_restriction dans
    pedagogie_services.py). Sans effet pour Cycle/AnneeScolaire/Trimestre/
    Sequence (roles_autorises inchangé, classe_scoped_self=False par défaut :
    ces référentiels restent établissement-larges pour tous les rôles qui y
    ont accès) ni pour Admin/SuperAdmin (résolu à None)."""
    bp = Blueprint(f'{name}_api', __name__, url_prefix=url_prefix)

    @bp.before_request
    @jwt_required()
    def _require_role():
        # Libellés alignés sur authentification_models.Role.init_roles() : le rôle
        # d'établissement est désormais 'Admin' (ex-'GestionnaireEtablissement').
        # 'SuperAdmin' garde un accès de consultation/administration transverse.
        # Censeur/Surveillant ont ici un accès lecture+écriture, comme Admin
        # (Cycle, Classe, AnneeScolaire, Trimestre, Sequence) — restreint aux
        # classes assignées pour Classe (cf. classe_scoped_self), et au verbe
        # POST près pour classe_bp (cf. create_roles_autorises et create()
        # ci-dessous).
        role = get_jwt().get("role")
        if request.method == "GET" and (role in roles_autorises or role in lecture_etablissement_roles):
            return
        if request.method != "GET" and role in roles_ecriture:
            return
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

    def _current_classe_restriction():
        if not classe_scoped_self:
            return None
        claims = get_jwt()
        if claims.get("role") in lecture_etablissement_roles:
            return None
        # user_id (identité du compte) vient de get_jwt_identity(), TOUJOURS
        # à jour — contrairement à claims.get("profil_id"), qui n'était
        # calculé qu'une fois au login/refresh et pouvait donc rester périmé
        # si le profil Censeur/Surveillant était relié (ou ses classes
        # (ré)assignées) après l'émission du token en cours. Voir
        # pedagogie_services.resolve_classe_ids_restriction.
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
        data = request.get_json(silent=True) or {}
        etab_id = data.get("etablissement_id") if claims.get("role") == "SuperAdmin" \
            else claims.get("etablissement_id")
        if not etab_id:
            return jsonify({"erreur": "etablissement_id requis"}), 400
        result, status = create_entity_scoped(model, data, etab_id)
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

    return bp


# ---------------------------------------------------------------------------
# Blueprint PUBLIC — sert les fichiers logo stockés dans storage/logos/
# Volontairement SANS jwt_required : un logo affiché via <img src="..."> ne
# porte pas d'en-tête Authorization, et un logo d'établissement n'est de
# toute façon pas une donnée sensible.
# ---------------------------------------------------------------------------

etablissement_logo_bp = Blueprint('etablissement_logo_api', __name__, url_prefix='/api/etablissements/storage/logos')


@etablissement_logo_bp.route('/<path:filename>', methods=['GET'])
def get_logo(filename):
    return send_from_directory(LOGOS_DIR, filename)


# ---------------------------------------------------------------------------
# Enregistrement des blueprints
# ---------------------------------------------------------------------------

etablissement_bp = make_admin_crud_blueprint('etablissement', Etablissement, '/api/etablissements')

# Référentiels lus par les pages Paiements (Comptable) et Élèves / Parents /
# Inscriptions (Secrétaire) — cf. make_scoped_crud_blueprint.
LECTURE_ETABLISSEMENT = ("Comptable", "Secretaire")

cycle_bp = make_scoped_crud_blueprint('cycle', Cycle, '/api/cycles',
                                      lecture_etablissement_roles=LECTURE_ETABLISSEMENT)
# classe_scoped_self=True : un Censeur/Surveillant ne voit que les classes
# qui lui ont été assignées (cf. CenseurClasse/SurveillantClasse).
classe_bp = make_scoped_crud_blueprint(
    'classe', Classe, '/api/classes',
    classe_scoped_self=True,
    lecture_etablissement_roles=LECTURE_ETABLISSEMENT,
)
annee_scolaire_bp = make_scoped_crud_blueprint('annee_scolaire', AnneeScolaire, '/api/annees-scolaires',
                                               lecture_etablissement_roles=LECTURE_ETABLISSEMENT)
trimestre_bp = make_scoped_crud_blueprint('trimestre', Trimestre, '/api/trimestres')
sequence_bp = make_scoped_crud_blueprint('sequence', Sequence, '/api/sequences')