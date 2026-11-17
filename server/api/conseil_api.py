import re
import unicodedata
from datetime import date
from pathlib import Path

from flask import Blueprint, Response, jsonify, render_template, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from extensions import db
from models.structure_models import Etablissement
from services.conseil_services import ConseilErreur, construire_conseil, perimetres
from services.pedagogie_services import resolve_classe_ids_restriction
from services.structure_services import LOGOS_DIR

# ---------------------------------------------------------------------------
# Conseil de classe (cf. services/conseil_services.py) :
#   GET /api/conseil/perimetres                     -> classes, niveaux, cycles
#   GET /api/conseil/?annee_scolaire_id=&periode=&portee=&cible=   -> JSON
#   GET /api/conseil/html?...                       -> aperçu / impression
#   GET /api/conseil/pdf?...                        -> PDF A4 (WeasyPrint)
# periode : seq:<id> | tri:<id> | annuel ; portee : classe | niveau | cycle |
# etablissement (cible : id de classe, clé de niveau, id de cycle).
# Admin / SuperAdmin : tous les périmètres ; Censeur : ses classes, une à une.
# ---------------------------------------------------------------------------

ROLES_CONSEIL = ("Admin", "SuperAdmin", "Censeur")

conseil_bp = Blueprint('conseil_api', __name__, url_prefix='/api/conseil')


@conseil_bp.before_request
@jwt_required()
def _require_role_conseil():
    if get_jwt().get("role") not in ROLES_CONSEIL:
        return jsonify({"erreur": "Accès non autorisé"}), 403


@conseil_bp.errorhandler(ConseilErreur)
def _erreur(err):
    return jsonify({"erreur": err.message}), err.status


def _etablissement():
    claims = get_jwt()
    etab_id = request.args.get("etablissement_id", type=int) if claims.get("role") == "SuperAdmin" \
        else claims.get("etablissement_id")
    etablissement = db.session.get(Etablissement, etab_id) if etab_id else None
    if etablissement is None:
        raise ConseilErreur("etablissement_id requis")
    return etablissement


def _restriction():
    role = get_jwt().get("role")
    if role in ("Admin", "SuperAdmin"):
        return None
    return resolve_classe_ids_restriction(role, int(get_jwt_identity()))


def _donnees():
    etablissement = _etablissement()
    data = construire_conseil(
        etablissement,
        request.args.get("annee_scolaire_id", type=int),
        request.args.get("periode"),
        request.args.get("portee") or 'classe',
        request.args.get("cible"),
        _restriction(),
    )
    return etablissement, data


def _rendu(data, logo_src):
    return render_template("conseil/conseil_classe.html", data=data, logo_src=logo_src,
                           date_edition=date.today().strftime('%d/%m/%Y'))


@conseil_bp.route('/perimetres', methods=['GET'])
def conseil_perimetres():
    return jsonify(perimetres(_etablissement().id, _restriction())), 200


@conseil_bp.route('/', methods=['GET'])
def conseil_donnees():
    _, data = _donnees()
    return jsonify(data), 200


@conseil_bp.route('/html', methods=['GET'])
def conseil_html():
    etablissement, data = _donnees()
    logo = f"/api/etablissements/storage/logos/{etablissement.logo}" if etablissement.logo else None
    return Response(_rendu(data, logo), mimetype='text/html')


@conseil_bp.route('/pdf', methods=['GET'])
def conseil_pdf():
    etablissement, data = _donnees()
    try:
        from weasyprint import HTML
    except OSError:
        return jsonify({"erreur": "Génération PDF indisponible sur ce serveur (WeasyPrint/Pango manquant)"}), 503
    logo = Path(LOGOS_DIR) / etablissement.logo if etablissement.logo else None
    logo_src = logo.as_uri() if logo and logo.is_file() else None
    pdf = HTML(string=_rendu(data, logo_src)).write_pdf()
    nom = f"conseil_{data['intitule']}_{data['periode']['libelle']}"
    nom = re.sub(r'[^A-Za-z0-9_.-]+', '_', unicodedata.normalize('NFKD', nom).encode('ascii', 'ignore').decode())
    return Response(pdf, mimetype='application/pdf',
                    headers={"Content-Disposition": f'attachment; filename="{nom}.pdf"'})
