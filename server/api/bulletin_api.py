import re
import unicodedata
from datetime import date
from pathlib import Path

from flask import Blueprint, Response, jsonify, render_template, request
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity

from extensions import db
from api.inscription_api import send_photo_eleve
from models.inscription_models import Eleve, Inscription
from models.structure_models import AnneeScolaire, Etablissement
from services.bulletin_services import BulletinErreur, construire_bulletins, periodes_disponibles
from services.inscription_services import chemin_photo_eleve
from services.pedagogie_services import resolve_classe_ids_restriction
from services.structure_services import LOGOS_DIR


# ---------------------------------------------------------------------------
# Blueprint BULLETINS — bulletins séquentiels, trimestriels et annuels,
# calculés côté serveur (services/bulletin_services.py) et rendus par un
# gabarit unique (static/templates/bulletins/bulletin.html) :
#   GET /api/bulletins/periodes?annee_scolaire_id=
#   GET /api/bulletins/?classe_id=&annee_scolaire_id=&periode=     -> JSON
#   GET /api/bulletins/html?...&inscription_ids=1,2&ordre=          -> aperçu / impression
#   GET /api/bulletins/pdf?...&inscription_ids=1,2&ordre=           -> PDF (WeasyPrint)
# periode : seq:<id> | tri:<id> | annuel. ordre : alphabetique (défaut) | rang.
#
# Admin/SuperAdmin : toutes les classes de l'établissement ; Censeur/
# Surveillant : uniquement leurs classes assignées (résolues en direct, cf.
# resolve_classe_ids_restriction).
# ---------------------------------------------------------------------------

ROLES_BULLETIN = ("Admin", "SuperAdmin", "Censeur", "Surveillant")

bulletin_bp = Blueprint('bulletin_api', __name__, url_prefix='/api/bulletins')


@bulletin_bp.before_request
@jwt_required()
def _require_role_bulletin():
    if get_jwt().get("role") not in ROLES_BULLETIN:
        return jsonify({"erreur": "Accès non autorisé"}), 403


def _etablissement():
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        etab_id = request.args.get("etablissement_id", type=int)
    else:
        etab_id = claims.get("etablissement_id")
    return db.session.get(Etablissement, etab_id) if etab_id else None


def _classe_restriction():
    role = get_jwt().get("role")
    if role not in ("Censeur", "Surveillant"):
        return None
    return resolve_classe_ids_restriction(role, int(get_jwt_identity()))


def _inscription_ids():
    brut = request.args.get("inscription_ids")
    if not brut:
        return None
    return [int(x) for x in brut.split(',') if x.strip().isdigit()]


def _donnees():
    etablissement = _etablissement()
    if etablissement is None:
        raise BulletinErreur("etablissement_id requis")
    data = construire_bulletins(
        etablissement,
        request.args.get("classe_id", type=int),
        request.args.get("annee_scolaire_id", type=int),
        request.args.get("periode", ""),
        _classe_restriction(),
        _inscription_ids(),
    )
    if request.args.get("ordre") == "rang":
        data["bulletins"].sort(key=lambda b: (b["rang"] is None, b["rang"] or 0,
                                              b["eleve"]["nom"], b["eleve"]["prenom"]))
    else:
        data["bulletins"].sort(key=lambda b: (b["eleve"]["nom"], b["eleve"]["prenom"]))
    return etablissement, data


def _rendu(data, logo_src, photos=None):
    return render_template("bulletins/bulletin.html", data=data, logo_src=logo_src, photos=photos or {},
                           date_edition=date.today().strftime('%d/%m/%Y'))


def _eleves_avec_photo(data):
    """Élèves des bulletins demandés dont la photo existe bien sur le disque."""
    ids = [b["eleve"]["id"] for b in data["bulletins"]]
    if not ids:
        return []
    return [e for e in Eleve.query.filter(Eleve.id.in_(ids), Eleve.photo.isnot(None)).all()
            if chemin_photo_eleve(e)]


def _photos_http(etablissement, data):
    """{eleve_id: URL} pour l'aperçu HTML (même origine, cookie JWT envoyé
    par le <img>), servies par bulletin_photo_eleve ci-dessous."""
    suffixe = f"&etablissement_id={etablissement.id}" if get_jwt().get("role") == "SuperAdmin" else ""
    return {e.id: f"/api/bulletins/photos/{e.id}?v={e.photo.split('.')[0]}{suffixe}"
            for e in _eleves_avec_photo(data)}


def _photos_fichiers(data):
    """{eleve_id: file://...} pour WeasyPrint, qui lit les fichiers en local
    (même principe que le logo)."""
    return {e.id: Path(chemin_photo_eleve(e)).as_uri() for e in _eleves_avec_photo(data)}


@bulletin_bp.errorhandler(BulletinErreur)
def _erreur_bulletin(err):
    return jsonify({"erreur": err.message}), err.status


@bulletin_bp.route('/periodes', methods=['GET'])
def bulletin_periodes():
    etablissement = _etablissement()
    if etablissement is None:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    annee = AnneeScolaire.query.filter_by(id=request.args.get("annee_scolaire_id", type=int),
                                          etablissement_id=etablissement.id).first()
    if not annee:
        return jsonify({"erreur": "Année scolaire introuvable"}), 404
    return jsonify(periodes_disponibles(annee.id)), 200


@bulletin_bp.route('/photos/<int:eleve_id>', methods=['GET'])
def bulletin_photo_eleve(eleve_id):
    """Photo d'identité affichée dans l'aperçu HTML du bulletin. Admin/
    SuperAdmin : tout élève de l'établissement ; Censeur/Surveillant :
    uniquement un élève inscrit dans l'une de leurs classes assignées. 404
    dans tous les cas de refus (on ne révèle pas l'existence de l'élève)."""
    etablissement = _etablissement()
    eleve = db.session.get(Eleve, eleve_id) if etablissement else None
    if not eleve or eleve.etablissement_id != etablissement.id or not chemin_photo_eleve(eleve):
        return jsonify({"erreur": "Photo non trouvée"}), 404

    restriction = _classe_restriction()
    if restriction is not None:
        dans_mes_classes = bool(restriction) and db.session.query(
            Inscription.query.filter(Inscription.eleve_id == eleve.id,
                                     Inscription.classe_id.in_(restriction)).exists()
        ).scalar()
        if not dans_mes_classes:
            return jsonify({"erreur": "Photo non trouvée"}), 404

    return send_photo_eleve(eleve)


@bulletin_bp.route('/', methods=['GET'])
def bulletin_donnees():
    _, data = _donnees()
    return jsonify(data), 200


@bulletin_bp.route('/html', methods=['GET'])
def bulletin_html():
    etablissement, data = _donnees()
    # Aperçu affiché dans la page (même origine) : URL HTTP du logo.
    logo_src = f"/api/etablissements/storage/logos/{etablissement.logo}" if etablissement.logo else None
    return Response(_rendu(data, logo_src, _photos_http(etablissement, data)), mimetype='text/html')


@bulletin_bp.route('/pdf', methods=['GET'])
def bulletin_pdf():
    etablissement, data = _donnees()
    if not data["bulletins"]:
        return jsonify({"erreur": "Aucun bulletin à générer"}), 404
    # Import différé : WeasyPrint dépend de bibliothèques système (Pango) ;
    # leur absence ne doit pas empêcher le démarrage de l'API.
    try:
        from weasyprint import HTML
    except OSError:
        return jsonify({"erreur": "Génération PDF indisponible sur ce serveur (WeasyPrint/Pango manquant)"}), 503

    logo = Path(LOGOS_DIR) / etablissement.logo if etablissement.logo else None
    logo_src = logo.as_uri() if logo and logo.is_file() else None
    pdf = HTML(string=_rendu(data, logo_src, _photos_fichiers(data))).write_pdf()

    nom = f"bulletins_{data['classe']['label']}_{data['periode']['libelle']}"
    if len(data["bulletins"]) == 1:
        eleve = data["bulletins"][0]["eleve"]
        nom = f"bulletin_{eleve['nom']}_{eleve['prenom']}_{data['periode']['libelle']}"
    # En-tête HTTP en ASCII (accents retirés, caractères spéciaux remplacés).
    nom = re.sub(r'[^A-Za-z0-9_.-]+', '_', unicodedata.normalize('NFKD', nom).encode('ascii', 'ignore').decode())
    return Response(pdf, mimetype='application/pdf',
                    headers={"Content-Disposition": f'attachment; filename="{nom}.pdf"'})
