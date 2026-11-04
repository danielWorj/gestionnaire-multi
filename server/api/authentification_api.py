from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import (
    jwt_required, get_jwt_identity, get_jwt, verify_jwt_in_request,
    set_access_cookies, set_refresh_cookies, unset_jwt_cookies
)
from services.authentification_services import (
    create_utilisateur, login, refresh_token, logout,
    get_all_utilisateurs, get_utilisateur_by_id, update_utilisateur,
    delete_utilisateur, change_password, reset_temp_password,
    login_superadmin, refresh_superadmin_token, logout_superadmin,
    get_superadmin_by_id, change_password_superadmin,
    choisir_role, role_ids_de
)
from datetime import datetime
from flask_limiter.util import get_remote_address
from models.authentification_models import Role, SuperAdmin, TokenBlocklist, Utilisateur, hash_token, normaliser_code
from services.authentification_services import session_ouverte
from extensions import db, jwt, limiter

authentification_bp = Blueprint('authentification', __name__, url_prefix='/api/auth')


def _est_superadmin(claims):
    return claims.get('type_compte') == 'superadmin'


def _cle_code_et_ip():
    """Clé de la limite des PIN faux : couple (code saisi, IP)."""
    data = request.get_json(silent=True) or {}
    code = normaliser_code(str(data.get('code') or '')) or '-'
    return f"login:{code}:{get_remote_address()}"


def _cle_session_refresh():
    """Clé de la limite de /refresh : la session (cookie de refresh), et non
    l'IP partagée par toute une école."""
    cookie = request.cookies.get('refresh_token_cookie')
    return f"refresh:{hash_token(cookie)}" if cookie else f"refresh-ip:{get_remote_address()}"


def _contient_role_admin(role_ids):
    if not isinstance(role_ids, list) or not role_ids:
        return False
    return Role.query.filter(Role.id.in_(role_ids), Role.libelle == 'Admin').first() is not None


# ============================================================================
# LISTE NOIRE DE TOKENS — révocation immédiate
#
# Enregistré une seule fois pour toute l'application (ce module est importé
# au démarrage via le blueprint). Consulté par flask-jwt-extended à chaque
# @jwt_required() : si le jti du token présenté a été explicitement révoqué
# (logout, compromission détectée), la requête est rejetée avec 401, sans
# attendre l'expiration naturelle du token.
# ============================================================================

@jwt.token_in_blocklist_loader
def _token_est_revoque(jwt_header, jwt_payload):
    return TokenBlocklist.est_revoque(jwt_payload.get('jti'))


# Réponses d'erreur JWT au même format que le reste de l'API ({"erreur": ...})
# au lieu du {"msg": ...} par défaut de flask-jwt-extended, que le front
# n'affichait pas. 'code' permet au front de savoir s'il doit tenter /refresh.

@jwt.unauthorized_loader
def _jwt_absent(raison):
    return jsonify({"erreur": "Authentification requise", "code": "token_absent"}), 401


@jwt.expired_token_loader
def _jwt_expire(jwt_header, jwt_payload):
    return jsonify({"erreur": "Session expirée", "code": "token_expire"}), 401


@jwt.invalid_token_loader
def _jwt_invalide(raison):
    return jsonify({"erreur": "Token invalide", "code": "token_invalide"}), 401


@jwt.revoked_token_loader
def _jwt_revoque(jwt_header, jwt_payload):
    return jsonify({"erreur": "Session révoquée", "code": "token_revoque"}), 401


def _cookies_response(payload, status, access_token=None, refresh_token_str=None, clear=False):
    """Construit une réponse JSON et y attache/retire les cookies JWT httpOnly.
    Les tokens ne transitent JAMAIS dans le corps JSON : uniquement via des
    cookies httpOnly + Secure + SameSite, invisibles pour tout JS côté client
    (protection contre le vol de token par XSS)."""
    resp = jsonify(payload)
    if clear:
        unset_jwt_cookies(resp)
    if access_token:
        set_access_cookies(resp, access_token)
    if refresh_token_str:
        set_refresh_cookies(resp, refresh_token_str)
    return resp, status


# ============================================================================
# ENDPOINTS D'AUTHENTIFICATION - UTILISATEUR
# ============================================================================

@authentification_bp.route('/login', methods=['POST'])
@limiter.limit(lambda: current_app.config.get('RATELIMIT_LOGIN', '60 per minute'))
# Seuls les PIN faux (401) sont décomptés : une IP qui enchaîne les essais
# sur un code est arrêtée ici, avant d'avoir pu verrouiller le compte.
@limiter.limit(lambda: current_app.config.get('RATELIMIT_LOGIN_ECHECS', '5 per 15 minutes'),
               key_func=_cle_code_et_ip, deduct_when=lambda response: response.status_code == 401,
               error_message="Trop de PIN incorrects depuis cet appareil : réessayez dans quelques minutes.")
def login_user():
    """
    Authentification d'un utilisateur par code de connexion + PIN
    Body: {code, pin}
    Les tokens générés sont posés en cookies httpOnly ; la réponse JSON ne
    contient que les infos utilisateur (non sensibles) pour l'affichage UI.
    """
    data = request.get_json(silent=True) or {}

    if not data.get('code') or not data.get('pin'):
        return jsonify({"erreur": "Code de connexion et PIN requis"}), 400

    result, status = login(str(data['code']), str(data['pin']))

    if status != 200:
        return jsonify(result), status

    return _cookies_response(
        {"message": "Connexion réussie", "utilisateur": result['utilisateur'],
         "role_actif": result['role_actif']},
        status,
        access_token=result['access_token'],
        refresh_token_str=result['refresh_token'],
    )


@authentification_bp.route('/choisir-role', methods=['POST'])
@jwt_required()
def choisir_role_endpoint():
    """
    Choisit (ou change) le rôle actif de la session d'un compte multi-rôles.
    Body: {role}  (libellé, ex. 'Censeur')
    Réémet les cookies JWT avec ce rôle actif et révoque l'access token
    précédent, pour qu'il ne puisse plus servir sous l'ancien rôle.
    """
    claims = get_jwt()
    if _est_superadmin(claims):
        return jsonify({"erreur": "Accès non autorisé"}), 403

    data = request.get_json(silent=True) or {}
    result, status = choisir_role(int(get_jwt_identity()), data.get('role'), claims.get('sid'))

    if status != 200:
        return jsonify(result), status

    TokenBlocklist.revoquer(claims.get('jti'), 'access', datetime.utcfromtimestamp(claims['exp']))
    db.session.commit()

    return _cookies_response(
        {"message": "Espace sélectionné", "role_actif": result['role_actif']},
        status,
        access_token=result['access_token'],
        refresh_token_str=result['refresh_token'],
    )


# NB : Utilisateur et SuperAdmin sont deux tables distinctes dont les ids se
# chevauchent (Utilisateur #1 et SuperAdmin #1 coexistent). Les endpoints de
# session ci-dessous (/refresh, /logout, /me, /change-password) sont communs
# aux deux types de compte : ils DOIVENT donc aiguiller selon le claim 'type'
# du token, sinon un token SuperAdmin #1 serait traité comme l'Utilisateur #1
# (fuite de données sur /me, révocation de la session d'un tiers sur /refresh).

@authentification_bp.route('/refresh', methods=['POST'])
@jwt_required(refresh=True)
@limiter.limit(lambda: current_app.config.get('RATELIMIT_REFRESH', '20 per minute'), key_func=_cle_session_refresh)
def refresh():
    """
    Rafraîchit le token d'accès. Le refresh token est lu depuis son cookie
    httpOnly (envoyé automatiquement par le navigateur, scoppé à
    JWT_REFRESH_COOKIE_PATH) — plus besoin de le transmettre dans le body.
    Rotation activée : un nouveau refresh token est émis et l'ancien devient
    inutilisable (voir services.refresh_token pour la détection de réutilisation).
    Fonctionne pour un Utilisateur comme pour un SuperAdmin (cf. claim 'type').
    """
    claims = get_jwt()
    identity = int(get_jwt_identity())
    presented_refresh = request.cookies.get('refresh_token_cookie')

    if _est_superadmin(claims):
        result, status = refresh_superadmin_token(identity, presented_refresh, claims.get('sid'))
    else:
        result, status = refresh_token(identity, presented_refresh, claims.get('role'), claims.get('sid'))

    if status != 200:
        return _cookies_response(result, status, clear=True)

    return _cookies_response(
        {"message": "Token rafraîchi"},
        status,
        access_token=result['access_token'],
        refresh_token_str=result['refresh_token'],
    )


@authentification_bp.route('/logout', methods=['POST'])
def logout_user():
    """
    Déconnexion : révoque la session (refresh token stocké côté serveur +
    liste noire de l'access token courant), puis efface les cookies.

    Volontairement SANS @jwt_required() : les cookies sont httpOnly, le JS ne
    peut pas les effacer lui-même. Si l'access token est expiré (ou le header
    CSRF absent), un @jwt_required() renverrait 401 et les cookies ne seraient
    jamais effacés — l'utilisateur se retrouverait « reconnecté » au
    rechargement suivant via /refresh. On révoque donc la session si le token
    est valide, et on efface les cookies dans tous les cas.
    """
    try:
        verify_jwt_in_request(optional=True)
        claims = get_jwt()
    except Exception:
        claims = {}

    if claims:
        identity = int(get_jwt_identity())
        if _est_superadmin(claims):
            logout_superadmin(identity, claims.get('jti'), claims.get('exp'), claims.get('sid'))
        else:
            logout(identity, claims.get('jti'), claims.get('exp'), claims.get('sid'))

    return _cookies_response({"message": "Déconnexion réussie"}, 200, clear=True)


@authentification_bp.route('/me', methods=['GET'])
@jwt_required()
def get_current_user():
    """
    Récupère les informations du compte connecté (Utilisateur ou SuperAdmin).
    Le champ 'type' permet au front de distinguer les deux.
    Pour un Utilisateur : 'roles' liste tous ses rôles, 'role' est le rôle
    actif de la session ({id, libelle}, ou None si un compte multi-rôles n'a
    pas encore choisi son espace — ou si son rôle actif lui a été retiré).
    """
    claims = get_jwt()
    identity = int(get_jwt_identity())

    if _est_superadmin(claims):
        superadmin = get_superadmin_by_id(identity)
        if not superadmin or not superadmin.actif:
            return jsonify({"erreur": "SuperAdmin non trouvé"}), 404
        data = superadmin.to_dict()
        data.update({
            'type': 'superadmin',
            'role': {'id': None, 'libelle': 'SuperAdmin'},
            'doit_changer_mdp': False,
        })
        return jsonify(data), 200

    utilisateur = get_utilisateur_by_id(identity)

    if not utilisateur or not utilisateur.actif:
        return jsonify({"erreur": "Utilisateur non trouvé"}), 404

    data = utilisateur.to_dict()
    data['type'] = 'utilisateur'
    # Rôle actif du token, s'il fait toujours partie des rôles du compte ;
    # sinon None : le front repasse par le choix d'espace (/choisir-role).
    data['role'] = next((r for r in data['roles'] if r['libelle'] == claims.get('role')), None)
    return jsonify(data), 200


@authentification_bp.route('/change-password', methods=['POST'])
@jwt_required()
def change_password_endpoint():
    """
    Change le secret du compte connecté.
    Utilisateur : son PIN, body {ancien_pin, nouveau_pin}.
    SuperAdmin : son mot de passe, body {old_password, new_password}.
    Révoque l'access token courant et les autres sessions. Utilisateur : de
    nouveaux cookies sont posés, il reste connecté. SuperAdmin : cookies
    effacés, reconnexion nécessaire.
    """
    claims = get_jwt()
    identity = int(get_jwt_identity())

    data = request.get_json(silent=True) or {}

    if _est_superadmin(claims):
        if not data.get('old_password') or not data.get('new_password'):
            return jsonify({"erreur": "Ancien et nouveau mot de passe requis"}), 400
        result, status = change_password_superadmin(
            identity, data['old_password'], data['new_password']
        )
    else:
        if not data.get('ancien_pin') or not data.get('nouveau_pin'):
            return jsonify({"erreur": "PIN actuel et nouveau PIN requis"}), 400
        result, status = change_password(
            identity, str(data['ancien_pin']), str(data['nouveau_pin']), claims.get('role'), claims.get('sid')
        )

    if status == 200:
        # L'access token courant reste sinon valide jusqu'à son expiration.
        TokenBlocklist.revoquer(claims.get('jti'), 'access', datetime.utcfromtimestamp(claims['exp']))
        db.session.commit()

    if status == 200 and 'access_token' in result:
        return _cookies_response(
            {"message": result['message'], "role_actif": result['role_actif']},
            status,
            access_token=result['access_token'],
            refresh_token_str=result['refresh_token'],
        )

    return _cookies_response(result, status, clear=(status == 200))


# ============================================================================
# CRUD UTILISATEURS
# Accès complet (toutes établissements) : SuperAdmin uniquement.
# Accès limité à son propre établissement : rôle 'Admin' (rôle d'établissement).
# ============================================================================

@authentification_bp.route('/utilisateurs', methods=['GET'])
@jwt_required()
def get_utilisateurs():
    """
    Récupère les utilisateurs.
    Query params: etablissement_id (optionnel, réservé à SuperAdmin), role (optionnel)
    """
    claims = get_jwt()

    if _est_superadmin(claims):
        # Le SuperAdmin peut voir tous les utilisateurs, filtrables par etablissement_id
        etablissement_id = request.args.get('etablissement_id', type=int)
    elif claims.get('role') == 'Admin':
        # L'Admin d'établissement ne voit que les utilisateurs de son établissement
        etablissement_id = claims.get('etablissement_id')
    else:
        return jsonify({"erreur": "Accès non autorisé"}), 403

    role = request.args.get('role')

    utilisateurs = get_all_utilisateurs(etablissement_id, role)

    return jsonify(utilisateurs), 200


@authentification_bp.route('/utilisateurs', methods=['POST'])
@jwt_required()
def create_utilisateur_endpoint():
    """
    Crée un nouvel utilisateur
    Body: {nom, role_ids (ou role_id), etablissement_id, email?, code_existant?}
    Si code_existant (ou à défaut l'email) désigne déjà un compte de
    l'établissement, les rôles lui sont ajoutés (200, 'compte_existant':
    True, sans nouveau PIN).
    Le code de connexion est attribué automatiquement et aucun PIN n'est
    accepté dans le payload : un PIN est TOUJOURS généré côté serveur et
    renvoyé une seule fois dans la réponse (clé historique
    'pin_temporaire'). Ce PIN est définitif ; l'utilisateur peut le changer
    quand il le souhaite depuis son espace (/change-password).
    """
    claims = get_jwt()

    if not _est_superadmin(claims) and claims.get('role') != 'Admin':
        return jsonify({"erreur": "Accès réservé à l'administrateur"}), 403

    data = request.get_json(silent=True)

    if not data:
        return jsonify({"erreur": "Données requises"}), 400

    required_fields = ['nom', 'etablissement_id']
    for field in required_fields:
        if field not in data:
            return jsonify({"erreur": f"Champ '{field}' requis"}), 400
    if not role_ids_de(data):
        return jsonify({"erreur": "Champ 'role_ids' requis"}), 400

    # Un Admin d'établissement ne peut créer que des utilisateurs de son propre établissement
    if not _est_superadmin(claims) and data['etablissement_id'] != claims.get('etablissement_id'):
        return jsonify({"erreur": "Accès non autorisé pour cet établissement"}), 403

    # Un Admin d'établissement ne peut pas créer un autre compte 'Admin' (privilège
    # réservé au SuperAdmin). Un SuperAdmin, lui, est un compte global distinct
    # (table super_admin, sans role_id) : il ne peut de toute façon pas être créé
    # via cet endpoint, qui ne porte que sur Utilisateur.
    if not _est_superadmin(claims) and _contient_role_admin(role_ids_de(data)):
        return jsonify({"erreur": "Un administrateur ne peut pas créer un autre administrateur"}), 403

    result, status = create_utilisateur(data)

    return jsonify(result), status


@authentification_bp.route('/utilisateurs/<int:user_id>', methods=['GET'])
@jwt_required()
def get_utilisateur(user_id):
    """
    Récupère un utilisateur par son ID : réservé au SuperAdmin, à l'Admin de
    son établissement, ou au titulaire du compte lui-même (la fiche contient
    le code de connexion, qui ne doit pas circuler parmi les autres comptes).
    """
    claims = get_jwt()

    if not (_est_superadmin(claims) or claims.get('role') == 'Admin'
            or int(get_jwt_identity()) == user_id):
        return jsonify({"erreur": "Accès non autorisé"}), 403

    utilisateur = get_utilisateur_by_id(user_id)

    if not utilisateur:
        return jsonify({"erreur": "Utilisateur non trouvé"}), 404

    if not _est_superadmin(claims) and utilisateur.etablissement_id != claims.get('etablissement_id'):
        return jsonify({"erreur": "Accès non autorisé"}), 403

    return jsonify(utilisateur.to_dict()), 200


@authentification_bp.route('/utilisateurs/<int:user_id>', methods=['PUT'])
@jwt_required()
def update_utilisateur_endpoint(user_id):
    """
    Met à jour un utilisateur
    Body: {nom, email, role_ids, etablissement_id, actif}
    role_ids remplace l'ensemble des rôles du compte.
    Ni le PIN ni le code de connexion ne se modifient via cet endpoint :
    l'utilisateur change son PIN via /change-password, ou un admin le
    réinitialise via /utilisateurs/<id>/reset-password (POST).
    """
    claims = get_jwt()

    if not _est_superadmin(claims) and claims.get('role') != 'Admin':
        return jsonify({"erreur": "Accès réservé à l'administrateur"}), 403

    utilisateur = get_utilisateur_by_id(user_id)
    if not utilisateur:
        return jsonify({"erreur": "Utilisateur non trouvé"}), 404

    if not _est_superadmin(claims) and utilisateur.etablissement_id != claims.get('etablissement_id'):
        return jsonify({"erreur": "Accès non autorisé"}), 403

    data = request.get_json(silent=True)

    if not data:
        return jsonify({"erreur": "Données requises"}), 400

    # Un Admin d'établissement ne gère pas les comptes Admin (y compris le
    # sien), à une exception près : il peut leur ajouter/retirer des rôles
    # NON-Admin (ex : un Admin qui enseigne aussi). Il ne peut en revanche ni
    # attribuer ni retirer le rôle Admin lui-même. Seul le SuperAdmin le peut.
    if not _est_superadmin(claims):
        cible_admin = utilisateur.a_role('Admin')
        if cible_admin and set(data) - {'role_ids'}:
            return jsonify({"erreur": "Seul un SuperAdmin peut modifier un compte administrateur"}), 403
        if 'role_ids' in data and _contient_role_admin(data['role_ids']) != cible_admin:
            return jsonify({"erreur": "Seul un SuperAdmin peut attribuer ou retirer le rôle administrateur"}), 403

    # Un Admin d'établissement ne peut pas déplacer un utilisateur vers un autre établissement
    if not _est_superadmin(claims) and 'etablissement_id' in data:
        data['etablissement_id'] = claims.get('etablissement_id')

    result, status = update_utilisateur(user_id, data)

    return jsonify(result), status


@authentification_bp.route('/utilisateurs/<int:user_id>', methods=['DELETE'])
@jwt_required()
def delete_utilisateur_endpoint(user_id):
    """
    Désactive un utilisateur (soft delete)
    """
    claims = get_jwt()

    if not _est_superadmin(claims) and claims.get('role') != 'Admin':
        return jsonify({"erreur": "Accès réservé à l'administrateur"}), 403

    utilisateur = get_utilisateur_by_id(user_id)
    if not utilisateur:
        return jsonify({"erreur": "Utilisateur non trouvé"}), 404

    if not _est_superadmin(claims) and utilisateur.etablissement_id != claims.get('etablissement_id'):
        return jsonify({"erreur": "Accès non autorisé"}), 403

    if not _est_superadmin(claims) and utilisateur.a_role('Admin'):
        return jsonify({"erreur": "Seul un SuperAdmin peut désactiver un compte administrateur"}), 403

    result, status = delete_utilisateur(user_id)

    return jsonify(result), status


@authentification_bp.route('/utilisateurs/<int:user_id>/reset-password', methods=['POST'])
@jwt_required()
def reset_password_endpoint(user_id):
    """
    Régénère un PIN pour un utilisateur (PIN oublié, compte bloqué après
    trop d'échecs). Renvoie le
    nouveau PIN en clair une seule fois ('pin_temporaire').
    """
    claims = get_jwt()

    if not _est_superadmin(claims) and claims.get('role') != 'Admin':
        return jsonify({"erreur": "Accès réservé à l'administrateur"}), 403

    utilisateur = get_utilisateur_by_id(user_id)
    if not utilisateur:
        return jsonify({"erreur": "Utilisateur non trouvé"}), 404

    if not _est_superadmin(claims) and utilisateur.etablissement_id != claims.get('etablissement_id'):
        return jsonify({"erreur": "Accès non autorisé"}), 403

    if not _est_superadmin(claims) and utilisateur.a_role('Admin'):
        return jsonify({"erreur": "Seul un SuperAdmin peut réinitialiser le PIN d'un administrateur"}), 403

    result, status = reset_temp_password(user_id)

    return jsonify(result), status


# ============================================================================
# GESTION DES RÔLES
# ============================================================================

@authentification_bp.route('/roles', methods=['GET'])
@jwt_required()
def get_roles():
    """
    Récupère tous les rôles disponibles
    """
    roles = Role.query.all()
    return jsonify([r.to_dict() for r in roles]), 200


# ============================================================================
# ENDPOINTS D'AUTHENTIFICATION - SUPERADMIN
# Compte global d'administration de la plateforme, indépendant de tout établissement.
# ============================================================================

superadmin_bp = Blueprint('superadmin_auth', __name__, url_prefix='/api/auth/superadmin')


@superadmin_bp.route('/login', methods=['POST'])
@limiter.limit(lambda: current_app.config.get('RATELIMIT_LOGIN_SUPERADMIN', '5 per minute'))
def login_superadmin_user():
    """
    Authentification d'un SuperAdmin
    Body: {email, password}
    """
    data = request.get_json(silent=True) or {}

    if not data.get('email') or not data.get('password'):
        return jsonify({"erreur": "Email et mot de passe requis"}), 400

    result, status = login_superadmin(data['email'], data['password'])

    if status != 200:
        return jsonify(result), status

    return _cookies_response(
        {"message": "Connexion réussie", "superadmin": result['superadmin']},
        status,
        access_token=result['access_token'],
        refresh_token_str=result['refresh_token'],
    )


@superadmin_bp.route('/refresh', methods=['POST'])
@jwt_required(refresh=True)
@limiter.limit(lambda: current_app.config.get('RATELIMIT_REFRESH', '20 per minute'), key_func=_cle_session_refresh)
def refresh_superadmin():
    """
    Rafraîchit le token d'accès SuperAdmin (rotation, cf. /refresh utilisateur).
    """
    claims = get_jwt()
    if not _est_superadmin(claims):
        return jsonify({"erreur": "Accès non autorisé"}), 403

    superadmin_id = int(get_jwt_identity())
    presented_refresh = request.cookies.get('refresh_token_cookie')

    result, status = refresh_superadmin_token(superadmin_id, presented_refresh, claims.get('sid'))

    if status != 200:
        return _cookies_response(result, status, clear=True)

    return _cookies_response(
        {"message": "Token rafraîchi"},
        status,
        access_token=result['access_token'],
        refresh_token_str=result['refresh_token'],
    )


@superadmin_bp.route('/logout', methods=['POST'])
@jwt_required()
def logout_superadmin_user():
    """
    Déconnexion SuperAdmin (révocation de la session + liste noire de l'access token)
    """
    claims = get_jwt()
    if not _est_superadmin(claims):
        return jsonify({"erreur": "Accès non autorisé"}), 403

    superadmin_id = int(get_jwt_identity())

    result, status = logout_superadmin(superadmin_id, claims.get('jti'), claims.get('exp'), claims.get('sid'))

    return _cookies_response(result, status, clear=True)


@superadmin_bp.route('/me', methods=['GET'])
@jwt_required()
def get_current_superadmin():
    """
    Récupère les informations du SuperAdmin connecté
    """
    claims = get_jwt()
    if not _est_superadmin(claims):
        return jsonify({"erreur": "Accès non autorisé"}), 403

    superadmin_id = int(get_jwt_identity())
    superadmin = get_superadmin_by_id(superadmin_id)

    if not superadmin:
        return jsonify({"erreur": "SuperAdmin non trouvé"}), 404

    return jsonify(superadmin.to_dict()), 200


@superadmin_bp.route('/change-password', methods=['POST'])
@jwt_required()
def change_password_superadmin_endpoint():
    """
    Change le mot de passe du SuperAdmin connecté. Révoque la session
    courante : les cookies sont effacés et une reconnexion est nécessaire.
    """
    claims = get_jwt()
    if not _est_superadmin(claims):
        return jsonify({"erreur": "Accès non autorisé"}), 403

    superadmin_id = int(get_jwt_identity())
    data = request.get_json(silent=True) or {}

    if not data.get('old_password') or not data.get('new_password'):
        return jsonify({"erreur": "Ancien et nouveau mot de passe requis"}), 400

    result, status = change_password_superadmin(
        superadmin_id,
        data['old_password'],
        data['new_password']
    )

    return _cookies_response(result, status, clear=(status == 200))


# ============================================================================
# MIDDLEWARE GLOBAL — changement de PIN imposé
#
# Les PIN générés sont définitifs (doit_changer_mdp reste à False) : ce
# garde-fou est aujourd'hui inactif, conservé au cas où un changement de PIN
# devrait un jour être imposé. Tant qu'un Utilisateur a doit_changer_mdp=True,
# il ne doit pouvoir accéder à AUCUNE ressource de l'application
# hormis le changement de mot de passe. Cette fonction doit être enregistrée au
# niveau de l'application (pas seulement de ce blueprint) pour s'appliquer à
# TOUTES les routes, y compris celles de structure_api.py et des autres modules :
#
#   from api.authentification_api import enforce_password_change
#   app.before_request(enforce_password_change)
# ============================================================================

# Endpoints accessibles même si l'utilisateur doit encore changer son mot de passe.
# (nom de blueprint.nom de fonction, cf. request.endpoint)
ENDPOINTS_MDP_TEMPORAIRE_AUTORISES = {
    # Connexion : un cookie encore valide d'un AUTRE compte (poste partagé)
    # ne doit jamais empêcher quelqu'un de se connecter.
    'authentification.login_user',
    'superadmin_auth.login_superadmin_user',
    'authentification.change_password_endpoint',
    'authentification.get_current_user',
    'authentification.logout_user',
    'authentification.refresh',
    # Route de page (app.py, hors blueprint) servant change-password.html :
    # doit rester accessible sinon la page elle-même serait bloquée par ce
    # middleware avant même que l'utilisateur ne puisse la voir.
    'change_password_page',
}


def enforce_password_change():
    """
    À enregistrer via app.before_request() dans l'application principale.
    Si le token présenté est celui d'un Utilisateur (pas un SuperAdmin) dont
    doit_changer_mdp=True, bloque toute route qui n'est pas dans la liste
    blanche ci-dessus.
    """
    # Preflight CORS : flask_jwt_extended exempte OPTIONS de la vérification,
    # donc aucun contexte JWT n'est posé et get_jwt() lèverait une RuntimeError.
    if request.method == 'OPTIONS':
        return None

    try:
        verify_jwt_in_request(optional=True)
    except Exception:
        return None  # token absent/invalide : laisser jwt_required() de la route gérer l'erreur

    claims = get_jwt()
    if not claims or claims.get('type_compte') != 'utilisateur':
        return None  # pas de token utilisateur (route publique, ou token SuperAdmin)

    if not claims.get('doit_changer_mdp'):
        return None

    if request.endpoint in ENDPOINTS_MDP_TEMPORAIRE_AUTORISES:
        return None

    return jsonify({
        "erreur": "Vous devez changer votre PIN avant de continuer",
        "doit_changer_mdp": True
    }), 403


# ============================================================================
# MIDDLEWARE GLOBAL — rôle actif
#
# Le claim 'role' (rôle actif) n'est recalculé qu'au login/refresh/choix
# d'espace : si un Admin retire ce rôle au compte (ou désactive le compte)
# pendant que la session est ouverte, le token resterait sinon utilisable
# sous ce rôle jusqu'à son expiration. On revérifie donc EN DIRECT, à chaque
# requête, que le compte est actif et possède toujours son rôle actif — même
# principe que resolve_classe_ids_restriction pour le périmètre des classes.
#
#   from api.authentification_api import enforce_role_actif
#   app.before_request(enforce_role_actif)   # après enforce_password_change
# ============================================================================

# Restent accessibles avec un rôle actif retiré, pour que le front puisse
# relire le compte puis faire choisir un autre espace.
ENDPOINTS_ROLE_ACTIF_EXEMPTES = {
    'authentification.login_user',
    'superadmin_auth.login_superadmin_user',
    'authentification.get_current_user',
    'authentification.choisir_role_endpoint',
    'authentification.logout_user',
    'authentification.refresh',
}


# Endpoints où une session fermée ne doit pas bloquer la requête.
ENDPOINTS_SESSION_EXEMPTES = {
    'authentification.login_user',
    'superadmin_auth.login_superadmin_user',
    'authentification.logout_user',
    'superadmin_auth.logout_superadmin_user',
    'authentification.refresh',
    'superadmin_auth.refresh_superadmin',
}


def enforce_role_actif():
    if request.method == 'OPTIONS':
        return None

    try:
        verify_jwt_in_request(optional=True)
    except Exception:
        return None

    claims = get_jwt()
    if not claims:
        return None

    # Session fermée (déconnexion de cet appareil, PIN réinitialisé ou
    # changé, compte désactivé) : l'access token est refusé tout de suite,
    # sans attendre ses 15 minutes de validité. 401 -> le front tente
    # /refresh, qui échoue, et renvoie à la connexion.
    if (request.endpoint not in ENDPOINTS_SESSION_EXEMPTES
            and claims.get('type_compte') in ('utilisateur', 'superadmin')
            and not session_ouverte(claims['type_compte'], int(get_jwt_identity()), claims.get('sid'))):
        return jsonify({"erreur": "Session révoquée", "code": "token_revoque"}), 401

    if request.endpoint in ENDPOINTS_ROLE_ACTIF_EXEMPTES:
        return None

    # Les routes métier accordent l'accès transverse sur claims['role'] ==
    # 'SuperAdmin'. Ce rôle n'est valable que porté par un token SuperAdmin
    # d'un compte SuperAdmin existant et actif (vérifié en direct : un compte
    # désactivé perd l'accès immédiatement, pas à l'expiration du token).
    if claims.get('role') == 'SuperAdmin' or _est_superadmin(claims):
        if (_est_superadmin(claims) and claims.get('role') == 'SuperAdmin'
                and db.session.query(SuperAdmin.query.filter(
                    SuperAdmin.id == int(get_jwt_identity()), SuperAdmin.actif.is_(True)
                ).exists()).scalar()):
            return None
        return jsonify({"erreur": "Accès non autorisé"}), 403

    if claims.get('type_compte') != 'utilisateur':
        return None

    filtres = [Utilisateur.id == int(get_jwt_identity()), Utilisateur.actif.is_(True)]
    if claims.get('role'):
        filtres.append(Utilisateur.roles.any(Role.libelle == claims['role']))
    if db.session.query(Utilisateur.query.filter(*filtres).exists()).scalar():
        return None

    return jsonify({
        "erreur": "Votre accès à cet espace a changé : choisissez à nouveau votre espace",
        "code": "role_revoque"
    }), 403