import re
import unicodedata
from datetime import date
from pathlib import Path

from flask import Blueprint, Response, jsonify, render_template, request
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity

from extensions import db
from models.structure_models import Etablissement
from models.structure_models import AnneeScolaire
from services.pv_services import PvErreur, construire_pv, sequences_de_l_annee
from services.trous_services import periodes_pv
from services.pedagogie_services import resolve_classe_ids_restriction
from services.structure_services import LOGOS_DIR


# ---------------------------------------------------------------------------
# Blueprint PV — procès-verbal d'évaluation (« Contrôle continu N°x »), calculé
# côté serveur (services/pv_services.py) et rendu par un gabarit unique
# (static/templates/pv/pv_evaluation.html) pour l'aperçu, l'impression et le PDF :
#   GET /api/pv/sequences?annee_scolaire_id=                          -> JSON
#   GET /api/pv/periodes?annee_scolaire_id=                           -> JSON
#   &periode=seq:<id> | seq:<id>:<cc|ds|evtr> | tri:<id> (remplace sequence_id)
#   GET /api/pv/?classe_id=&annee_scolaire_id=&sequence_id=&ordre=     -> JSON
#   GET /api/pv/html?...&valeurs=points|notes                          -> aperçu / impression
#   GET /api/pv/pdf?...                                                -> PDF A4 paysage (WeasyPrint)
# ordre : alphabetique (défaut) | rang.  valeurs : points (défaut) | notes.
#
# Admin et SuperAdmin : toutes les classes de l'établissement ; Censeur et
# Surveillant : leurs classes assignées ; Enseignant : les classes dont il
# est titulaire.
# Module indépendant du bulletin : rien n'est importé de bulletin_api.
# ---------------------------------------------------------------------------

ROLES_PV = ("Admin", "SuperAdmin", "Censeur", "Surveillant", "Enseignant")

pv_bp = Blueprint('pv_api', __name__, url_prefix='/api/pv')


@pv_bp.before_request
@jwt_required()
def _require_role_pv():
    if get_jwt().get("role") not in ROLES_PV:
        return jsonify({"erreur": "Accès non autorisé"}), 403


@pv_bp.errorhandler(PvErreur)
def _erreur_pv(err):
    return jsonify({"erreur": err.message}), err.status


def _etablissement():
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        etab_id = request.args.get("etablissement_id", type=int)
    else:
        etab_id = claims.get("etablissement_id")
    return db.session.get(Etablissement, etab_id) if etab_id else None


def _classe_restriction():
    role = get_jwt().get("role")
    if role in ("Admin", "SuperAdmin"):
        return None
    return resolve_classe_ids_restriction(role, int(get_jwt_identity()))


def _donnees():
    etablissement = _etablissement()
    if etablissement is None:
        raise PvErreur("etablissement_id requis")
    ordre = 'rang' if request.args.get("ordre") == 'rang' else 'alphabetique'
    classe_id = request.args.get("classe_id", type=int)
    restriction = _classe_restriction()
    if restriction is not None and classe_id not in restriction:
        raise PvErreur("Cette classe ne vous est pas assignée", 403)
    data = construire_pv(
        etablissement,
        classe_id,
        request.args.get("annee_scolaire_id", type=int),
        request.args.get("sequence_id", type=int),
        ordre,
        request.args.get("periode") or None,
    )
    return etablissement, data


def _taille_police(nb_matieres):
    """Police du tableau (pt) selon le nombre de colonnes de matières."""
    if nb_matieres <= 14:
        return 7.8
    if nb_matieres <= 18:
        return 7.2
    if nb_matieres <= 22:
        return 6.6
    return 6


def rendu_pv(data, logo_src):
    valeurs = 'notes' if request.args.get("valeurs") == 'notes' else 'points'
    return render_template("pv/pv_evaluation.html", data=data, logo_src=logo_src, valeurs=valeurs,
                           police=_taille_police(len(data["matieres"])),
                           date_edition=date.today().strftime('%d/%m/%Y'))


def logo_http(etablissement):
    """URL HTTP du logo pour l'aperçu affiché dans la page (même origine)."""
    return f"/api/etablissements/storage/logos/{etablissement.logo}" if etablissement.logo else None


@pv_bp.route('/sequences', methods=['GET'])
def pv_sequences():
    etablissement = _etablissement()
    if etablissement is None:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    return jsonify(sequences_de_l_annee(etablissement, request.args.get("annee_scolaire_id", type=int))), 200


@pv_bp.route('/periodes', methods=['GET'])
def pv_periodes():
    """Périodes du PV : séquences, évaluations (Collège/Institut), trimestres."""
    etablissement = _etablissement()
    if etablissement is None:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    annee = AnneeScolaire.query.filter_by(id=request.args.get("annee_scolaire_id", type=int),
                                          etablissement_id=etablissement.id).first()
    if not annee:
        return jsonify({"erreur": "Année scolaire introuvable"}), 404
    return jsonify(periodes_pv(annee)), 200


@pv_bp.route('/', methods=['GET'])
def pv_donnees():
    _, data = _donnees()
    return jsonify(data), 200


@pv_bp.route('/html', methods=['GET'])
def pv_html():
    etablissement, data = _donnees()
    return Response(rendu_pv(data, logo_http(etablissement)), mimetype='text/html')


@pv_bp.route('/pdf', methods=['GET'])
def pv_pdf():
    etablissement, data = _donnees()
    if not data["eleves"]:
        return jsonify({"erreur": "Aucun élève à afficher sur le procès-verbal"}), 404
    # Import différé : WeasyPrint dépend de bibliothèques système (Pango) ;
    # leur absence ne doit pas empêcher le démarrage de l'API.
    try:
        from weasyprint import HTML
    except OSError:
        return jsonify({"erreur": "Génération PDF indisponible sur ce serveur (WeasyPrint/Pango manquant)"}), 503

    logo = Path(LOGOS_DIR) / etablissement.logo if etablissement.logo else None
    logo_src = logo.as_uri() if logo and logo.is_file() else None
    pdf = HTML(string=rendu_pv(data, logo_src)).write_pdf()

    nom = f"pv_{data['classe']['label']}_{data['sequence']['libelle']}"
    # En-tête HTTP en ASCII (accents retirés, caractères spéciaux remplacés).
    nom = re.sub(r'[^A-Za-z0-9_.-]+', '_', unicodedata.normalize('NFKD', nom).encode('ascii', 'ignore').decode())
    return Response(pdf, mimetype='application/pdf',
                    headers={"Content-Disposition": f'attachment; filename="{nom}.pdf"'})
