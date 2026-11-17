from flask import Blueprint, jsonify, request, send_from_directory
from flask_jwt_extended import get_jwt, jwt_required

from services.epreuve_services import (
    lister_epreuves, deposer_epreuve, supprimer_epreuve, get_epreuve_scoped,
    chemin_epreuve, epreuves_dir_of,
)

# ---------------------------------------------------------------------------
# Blueprint ÉPREUVES (administration) — toutes les épreuves de l'établissement.
#
# Réservé à Admin et SuperAdmin. Le SuperAdmin choisit l'établissement par
# ?etablissement_id= (y compris sur le POST multipart : le paramètre reste dans
# l'URL, jamais dans le formulaire) ; l'Admin est toujours cantonné à celui de
# son compte (claim JWT).
#
# GET    /api/epreuves/?page&per_page=25&classe_id&matiere_id&enseignant_id
#                      &annee_scolaire_id
#        -> {items, total, page, pages, per_page}
# POST   /api/epreuves/   (multipart : titre, fichier, et matiere_classe_id OU
#        classe_id + matiere_id) : l'administration choisit classe + matière,
#        l'enseignant est celui de la MatiereClasse.
# GET    /api/epreuves/<id>/fichier  : téléchargement (pièce jointe)
# DELETE /api/epreuves/<id>
#
# Les enseignants déposent et suppriment leurs propres épreuves via
# /api/enseignant/epreuves (cf. evaluation_api.py). Formats, taille, stockage :
# cf. services/epreuve_services.py.
# ---------------------------------------------------------------------------

ROLES_EPREUVES = ("Admin", "SuperAdmin")
EPREUVES_PAR_PAGE_ADMIN = 25

epreuve_bp = Blueprint('epreuve_api', __name__, url_prefix='/api/epreuves')


@epreuve_bp.before_request
@jwt_required()
def _require_role_epreuve():
    if get_jwt().get("role") not in ROLES_EPREUVES:
        return jsonify({"erreur": "Accès non autorisé"}), 403
    return None


def _resolve_etablissement_id_epreuve():
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        return request.args.get("etablissement_id", type=int)
    return claims.get("etablissement_id")


@epreuve_bp.route('/', methods=['GET'])
def epreuve_get_all():
    etab_id = _resolve_etablissement_id_epreuve()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    return jsonify(lister_epreuves(
        etab_id,
        page=request.args.get("page", default=1, type=int),
        per_page=request.args.get("per_page", default=EPREUVES_PAR_PAGE_ADMIN, type=int),
        classe_id=request.args.get("classe_id", type=int),
        matiere_id=request.args.get("matiere_id", type=int),
        enseignant_id=request.args.get("enseignant_id", type=int),
        annee_scolaire_id=request.args.get("annee_scolaire_id", type=int),
    )), 200


@epreuve_bp.route('/', methods=['POST'])
def epreuve_create():
    etab_id = _resolve_etablissement_id_epreuve()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = deposer_epreuve(etab_id, request.form, request.files.get("fichier"))
    return jsonify(result), status


@epreuve_bp.route('/<int:id>/fichier', methods=['GET'])
def epreuve_telecharger(id):
    etab_id = _resolve_etablissement_id_epreuve()
    epreuve = get_epreuve_scoped(id, etab_id) if etab_id else None
    if epreuve is None:
        return jsonify({"erreur": "Épreuve non trouvée"}), 404
    if not chemin_epreuve(epreuve):
        return jsonify({"erreur": "Fichier introuvable sur le serveur"}), 404

    # Toujours en pièce jointe (jamais affiché dans le navigateur), sous le
    # nom d'origine ; le type est celui déduit de la signature au dépôt.
    response = send_from_directory(
        epreuves_dir_of(epreuve.etablissement_id), epreuve.fichier,
        as_attachment=True, download_name=epreuve.nom_original, mimetype=epreuve.mime,
    )
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@epreuve_bp.route('/<int:id>', methods=['DELETE'])
def epreuve_delete(id):
    etab_id = _resolve_etablissement_id_epreuve()
    epreuve = get_epreuve_scoped(id, etab_id) if etab_id else None
    if epreuve is None:
        return jsonify({"erreur": "Épreuve non trouvée"}), 404
    result, status = supprimer_epreuve(epreuve)
    return jsonify(result), status
