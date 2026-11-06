from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt, jwt_required

from models.audit_models import JournalAudit

# ---------------------------------------------------------------------------
# Journal d'audit — CONSULTATION uniquement (il est alimenté automatiquement
# par services/audit_services.py ; aucune route ne permet de l'écrire, de le
# modifier ni de l'effacer).
#
# - SuperAdmin : tout (?etablissement_id=tous), ou un établissement via ?etablissement_id=<id>
# - Admin      : tout le journal de SON établissement
# - Censeur    : le volet pédagogique de son établissement (notes,
#                discipline, emploi du temps)
#
# GET /api/audit/?table=note&ligne_id=12   historique d'une donnée
#     &auteur_id= &action= &depuis=AAAA-MM-JJ &jusqua=AAAA-MM-JJ
#     &page=1 &limite=50 (200 max)
# ---------------------------------------------------------------------------

ROLES_AUDIT = ("SuperAdmin", "Admin", "Censeur")
TABLES_CENSEUR = ("note", "discipline", "horaire")
LIMITE_MAX = 200

audit_bp = Blueprint('audit_api', __name__, url_prefix='/api/audit')


@audit_bp.before_request
@jwt_required()
def _require_role_audit():
    if get_jwt().get("role") not in ROLES_AUDIT:
        return jsonify({"erreur": "Accès non autorisé"}), 403
    if request.method != "GET":
        return jsonify({"erreur": "Le journal d'audit est en lecture seule"}), 405
    return None


def _date(param):
    brut = request.args.get(param)
    if not brut:
        return None
    try:
        return datetime.fromisoformat(brut)
    except ValueError:
        return False


@audit_bp.route('/', methods=['GET'])
def audit_liste():
    claims = get_jwt()
    role = claims.get("role")
    query = JournalAudit.query

    if role == "SuperAdmin":
        # ?etablissement_id=tous (ou absent) : tout le réseau, y compris les
        # actions hors établissement (comptes SuperAdmin, établissements).
        brut = request.args.get("etablissement_id", "tous")
        if brut != "tous":
            try:
                query = query.filter(JournalAudit.etablissement_id == int(brut))
            except ValueError:
                return jsonify({"erreur": "etablissement_id invalide"}), 400
    else:
        etab_id = claims.get("etablissement_id")
        if not etab_id:
            return jsonify({"erreur": "etablissement_id requis"}), 400
        query = query.filter(JournalAudit.etablissement_id == etab_id)
        if role == "Censeur":
            query = query.filter(JournalAudit.table_nom.in_(TABLES_CENSEUR))

    table = request.args.get("table")
    if table:
        query = query.filter(JournalAudit.table_nom == table)
    ligne_id = request.args.get("ligne_id")
    if ligne_id:
        query = query.filter(JournalAudit.ligne_id == str(ligne_id))
    auteur_id = request.args.get("auteur_id", type=int)
    if auteur_id:
        query = query.filter(JournalAudit.auteur_id == auteur_id)
    action = request.args.get("action")
    if action:
        query = query.filter(JournalAudit.action == action)

    depuis, jusqua = _date("depuis"), _date("jusqua")
    if depuis is False or jusqua is False:
        return jsonify({"erreur": "Date invalide (format attendu : AAAA-MM-JJ)"}), 400
    if depuis:
        query = query.filter(JournalAudit.horodatage >= depuis)
    if jusqua:
        # Date seule : la journée entière est incluse.
        borne = jusqua + timedelta(days=1) if len(request.args.get("jusqua", "")) <= 10 else jusqua
        query = query.filter(JournalAudit.horodatage < borne)

    page = max(request.args.get("page", 1, type=int) or 1, 1)
    limite = min(max(request.args.get("limite", 50, type=int) or 50, 1), LIMITE_MAX)
    total = query.count()
    items = (query.order_by(JournalAudit.horodatage.desc(), JournalAudit.id.desc())
             .offset((page - 1) * limite).limit(limite).all())
    return jsonify({"items": [e.to_dict() for e in items], "total": total, "page": page, "limite": limite}), 200
