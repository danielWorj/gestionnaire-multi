from flask import Blueprint, Response, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from api.bulletin_api import logo_http, rendu_bulletins, reponse_pdf
from api.inscription_api import send_photo_eleve
from extensions import db
from models.inscription_models import Eleve, Parent
from services.acces_parent_services import (
    debloquer_bulletin, etat_acces, nouveau_pin, ouvrir_acces, rattacher_enfant, retirer_acces,
)
from services.bulletin_services import BulletinErreur, construire_bulletins
from services.espace_parent_services import contexte_bulletin, enfant_du_parent, suivi_enfants
from services.inscription_services import chemin_photo_eleve


# ---------------------------------------------------------------------------
# Gestion des accès familles (page Parents) : /api/parents/<id>/...
#
# Secrétariat et administration (Admin, SuperAdmin, Secretaire) ouvrent
# l'accès d'une famille, régénèrent son PIN, rattachent ses enfants. Lever
# le blocage d'un bulletin est réservé à l'administration (Admin, SuperAdmin).
# Même cloisonnement que parent_bp (inscription_api.py) : établissement du
# JWT, ou ?etablissement_id= pour le SuperAdmin.
# ---------------------------------------------------------------------------

ROLES_GESTION = ("Admin", "SuperAdmin", "Secretaire")
ROLES_DEBLOCAGE = ("Admin", "SuperAdmin")

gestion_parents_bp = Blueprint('gestion_parents_api', __name__, url_prefix='/api/parents')


@gestion_parents_bp.before_request
@jwt_required()
def _require_role_gestion():
    if get_jwt().get("role") not in ROLES_GESTION:
        return jsonify({"erreur": "Accès non autorisé"}), 403
    return None


def _parent_gere(parent_id):
    claims = get_jwt()
    etab_id = (request.args.get("etablissement_id", type=int) if claims.get("role") == "SuperAdmin"
               else claims.get("etablissement_id"))
    parent = db.session.get(Parent, parent_id) if etab_id else None
    return parent if parent and parent.etablissement_id == etab_id else None


def _introuvable():
    return jsonify({"erreur": "Parent non trouvé"}), 404


@gestion_parents_bp.route('/<int:parent_id>/suivi', methods=['GET'])
def suivi_famille(parent_id):
    parent = _parent_gere(parent_id)
    if parent is None:
        return _introuvable()
    return jsonify({"acces": etat_acces(parent), **suivi_enfants(parent)}), 200


@gestion_parents_bp.route('/<int:parent_id>/acces', methods=['POST'])
def acces_ouvrir(parent_id):
    parent = _parent_gere(parent_id)
    if parent is None:
        return _introuvable()
    resultat, status = ouvrir_acces(parent)
    return jsonify(resultat), status


@gestion_parents_bp.route('/<int:parent_id>/acces/nouveau-pin', methods=['POST'])
def acces_nouveau_pin(parent_id):
    parent = _parent_gere(parent_id)
    if parent is None:
        return _introuvable()
    resultat, status = nouveau_pin(parent)
    return jsonify(resultat), status


@gestion_parents_bp.route('/<int:parent_id>/acces', methods=['DELETE'])
def acces_retirer(parent_id):
    parent = _parent_gere(parent_id)
    if parent is None:
        return _introuvable()
    resultat, status = retirer_acces(parent)
    return jsonify(resultat), status


@gestion_parents_bp.route('/<int:parent_id>/enfants', methods=['POST'])
def enfant_rattacher(parent_id):
    parent = _parent_gere(parent_id)
    if parent is None:
        return _introuvable()
    eleve_id = (request.get_json(silent=True) or {}).get("eleve_id")
    resultat, status = rattacher_enfant(parent, int(eleve_id) if str(eleve_id or '').isdigit() else None)
    return jsonify(resultat), status


@gestion_parents_bp.route('/<int:parent_id>/bulletins/<int:inscription_id>', methods=['PUT'])
def bulletin_deblocage(parent_id, inscription_id):
    if get_jwt().get("role") not in ROLES_DEBLOCAGE:
        return jsonify({"erreur": "Seule l'administration peut débloquer un bulletin"}), 403
    parent = _parent_gere(parent_id)
    if parent is None:
        return _introuvable()
    debloque = (request.get_json(silent=True) or {}).get("debloque")
    if not isinstance(debloque, bool):
        return jsonify({"erreur": "debloque (true/false) requis"}), 400
    resultat, status = debloquer_bulletin(parent, inscription_id, debloque)
    return jsonify(resultat), status


# ---------------------------------------------------------------------------
# Espace parent : /api/parent/...  (rôle Parent uniquement)
#
# Le parent connecté ne voit QUE ses enfants (Eleve.parent_id = sa fiche,
# résolue en direct depuis le compte : Parent.utilisateur_id). Toute autre
# ressource répond 404, sans révéler si elle existe.
# ---------------------------------------------------------------------------

espace_parent_bp = Blueprint('espace_parent_api', __name__, url_prefix='/api/parent')


@espace_parent_bp.before_request
@jwt_required()
def _require_role_parent():
    if get_jwt().get("role") != "Parent":
        return jsonify({"erreur": "Accès non autorisé"}), 403
    return None


def _ma_famille():
    return Parent.query.filter_by(utilisateur_id=int(get_jwt_identity()),
                                  etablissement_id=get_jwt().get("etablissement_id")).first()


ERREUR_FAMILLE_NON_RELIEE = {"erreur": "Aucune famille n'est reliée à ce compte. "
                                       "Contactez le secrétariat de l'établissement."}


@espace_parent_bp.route('/mon-espace', methods=['GET'])
def mon_espace():
    parent = _ma_famille()
    if parent is None:
        return jsonify(ERREUR_FAMILLE_NON_RELIEE), 404
    etab = parent.etablissement
    return jsonify({
        "parent": {"nom": parent.nom, "prenom": parent.prenom},
        "etablissement": {"nom": etab.nom, "telephone": etab.telephone, "logo_url": etab.to_dict()["logo_url"]},
        **suivi_enfants(parent),
    }), 200


@espace_parent_bp.route('/enfants/<int:eleve_id>/photo', methods=['GET'])
def photo_enfant(eleve_id):
    parent = _ma_famille()
    eleve = enfant_du_parent(parent, eleve_id) if parent else None
    if not chemin_photo_eleve(eleve):
        return jsonify({"erreur": "Photo non trouvée"}), 404
    return send_photo_eleve(eleve)


def _bulletin(eleve_id):
    """(etablissement, data) du bulletin demandé, ou (None, réponse d'erreur)."""
    parent = _ma_famille()
    if parent is None:
        return None, (jsonify(ERREUR_FAMILLE_NON_RELIEE), 404)
    periode = request.args.get("periode", "")
    contexte, erreur = contexte_bulletin(parent, eleve_id, periode)
    if erreur:
        return None, (jsonify(erreur[0]), erreur[1])
    inscription, annee = contexte
    try:
        data = construire_bulletins(parent.etablissement, inscription.classe_id, annee.id, periode,
                                    inscription_ids=[inscription.id])
    except BulletinErreur as err:
        return None, (jsonify({"erreur": err.message}), err.status)
    return (parent.etablissement, data), None


@espace_parent_bp.route('/enfants/<int:eleve_id>/bulletin', methods=['GET'])
def bulletin_enfant(eleve_id):
    resultat, erreur = _bulletin(eleve_id)
    if erreur:
        return erreur
    etablissement, data = resultat
    eleves = [db.session.get(Eleve, b["eleve"]["id"]) for b in data["bulletins"]]
    photos = {e.id: f"/api/parent/enfants/{e.id}/photo?v={e.photo.split('.')[0]}"
              for e in eleves if chemin_photo_eleve(e)}
    return Response(rendu_bulletins(data, logo_http(etablissement), photos), mimetype='text/html')


@espace_parent_bp.route('/enfants/<int:eleve_id>/bulletin.pdf', methods=['GET'])
def bulletin_enfant_pdf(eleve_id):
    resultat, erreur = _bulletin(eleve_id)
    if erreur:
        return erreur
    return reponse_pdf(*resultat)
