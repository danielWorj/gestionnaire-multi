from models.authentification_models import (
    Utilisateur, Role, SuperAdmin, TokenBlocklist, generate_temp_password,
    valider_force_mot_de_passe, TEMP_PASSWORD_VALIDITY_HOURS
)
from models.structure_models import Etablissement
from extensions import db
from flask import current_app
from flask_jwt_extended import create_access_token, create_refresh_token
from datetime import datetime, timedelta
from sqlalchemy.exc import IntegrityError

# NB : les durées de vie des tokens (ACCESS/REFRESH) ne sont plus codées en
# dur ici pour éviter toute divergence avec config.py (source unique de
# vérité) : voir _token_lifetimes() ci-dessous, qui lit
# current_app.config['JWT_ACCESS_TOKEN_EXPIRES'] / ['JWT_REFRESH_TOKEN_EXPIRES'].

# Durée de validité d'un mot de passe temporaire (généré automatiquement à la
# création d'un Utilisateur, ou lors d'une réinitialisation)
TEMP_PASSWORD_VALIDITY = timedelta(hours=TEMP_PASSWORD_VALIDITY_HOURS)


def _token_lifetimes():
    """Lit les durées de vie des tokens depuis la config Flask active, pour
    n'avoir qu'une seule source de vérité (config.py)."""
    return (
        current_app.config['JWT_ACCESS_TOKEN_EXPIRES'],
        current_app.config['JWT_REFRESH_TOKEN_EXPIRES'],
    )


def _build_claims(utilisateur):
    """Construit les claims additionnelles (role, etablissement_id) du JWT d'un Utilisateur.
    L'identity reste le seul user_id (obligatoire en string avec flask-jwt-extended),
    role/etablissement_id passent en additional_claims pour être lisibles
    directement via get_jwt() côté API. 'type' permet de distinguer un token
    Utilisateur d'un token SuperAdmin (identités numériques potentiellement identiques)."""
    return {
        'type': 'utilisateur',
        'role': utilisateur.role.libelle,
        'etablissement_id': utilisateur.etablissement_id,
        'doit_changer_mdp': utilisateur.doit_changer_mdp
    }


def _build_superadmin_claims(superadmin):
    return {
        'type': 'superadmin',
        'role': 'SuperAdmin'
    }


# ============================================================================
# UTILISATEUR
# ============================================================================

def create_utilisateur(data):
    """
    Crée un nouvel utilisateur (personnel/parent rattaché à un établissement).
    data: {nom, email, role_id, etablissement_id, password (optionnel)}
    NB : etablissement_id est désormais obligatoire pour tout Utilisateur, y compris
    ceux ayant le rôle 'Admin' (rôle d'établissement). Le compte d'administration
    globale hors établissement se crée via create_superadmin().

    Si 'password' n'est pas fourni (cas normal : le SuperAdmin crée l'Admin
    d'un établissement, ou un Admin crée un membre de son personnel), un mot
    de passe temporaire est généré aléatoirement. L'utilisateur devra le
    changer dès sa première connexion (doit_changer_mdp=True), et ce mot de
    passe temporaire n'est valable que 48h (mdp_expire_le) : passé ce délai,
    il ne permet plus de se connecter et doit être régénéré par un admin
    (cf. reset_temp_password).
    """
    try:
        if not data.get('etablissement_id'):
            return {"erreur": "etablissement_id requis"}, 400

        # Vérifier que l'établissement existe
        etablissement = Etablissement.query.get(data['etablissement_id'])
        if not etablissement:
            return {"erreur": "Établissement invalide"}, 400

        # Vérifier si l'email existe déjà pour cet établissement
        existing = Utilisateur.query.filter_by(
            email=data['email'],
            etablissement_id=data['etablissement_id']
        ).first()

        if existing:
            return {"erreur": "Un utilisateur avec cet email existe déjà dans cet établissement"}, 409

        # Vérifier que le rôle existe
        role = Role.query.get(data['role_id'])
        if not role:
            return {"erreur": "Rôle invalide"}, 400

        mot_de_passe_genere = None
        if data.get('password'):
            # Mot de passe explicitement fourni par l'appelant : pas de contrainte
            # de changement forcé (cas d'usage rare, ex. script de migration).
            # On applique quand même la politique de force du mot de passe :
            # un appelant (même admin) ne doit pas pouvoir imposer "1234" à un compte.
            valide, message = valider_force_mot_de_passe(data['password'])
            if not valide:
                return {"erreur": message}, 400
            mot_de_passe_a_definir = data['password']
            doit_changer_mdp = False
            mdp_expire_le = None
        else:
            mot_de_passe_genere = generate_temp_password()
            mot_de_passe_a_definir = mot_de_passe_genere
            doit_changer_mdp = True
            mdp_expire_le = datetime.utcnow() + TEMP_PASSWORD_VALIDITY

        utilisateur = Utilisateur(
            nom=data['nom'],
            email=data['email'],
            role_id=data['role_id'],
            etablissement_id=data['etablissement_id'],
            actif=True,
            doit_changer_mdp=doit_changer_mdp,
            mdp_expire_le=mdp_expire_le
        )

        utilisateur.set_password(mot_de_passe_a_definir)

        db.session.add(utilisateur)
        db.session.commit()

        result = utilisateur.to_dict()
        if mot_de_passe_genere:
            # Communiqué UNE SEULE FOIS ici : le hash bcrypt n'est pas réversible,
            # donc ce mot de passe en clair ne sera plus jamais récupérable ensuite.
            result['mot_de_passe_temporaire'] = mot_de_passe_genere
        return result, 201

    except IntegrityError:
        db.session.rollback()
        return {"erreur": "Violation de contrainte d'unicité"}, 409
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la création"}, 500


def login(email, password, etablissement_id=None):
    """
    Authentifie un utilisateur et génère les tokens JWT
    Retourne: {access_token, refresh_token, utilisateur} ou erreur
    """
    # Trouver l'utilisateur
    query = Utilisateur.query.filter_by(email=email)
    if etablissement_id:
        query = query.filter_by(etablissement_id=etablissement_id)

    utilisateurs = query.all()

    # Un même email peut exister dans plusieurs établissements : si l'appelant
    # n'a pas précisé etablissement_id et qu'il y a ambiguïté, on lui demande de préciser
    if len(utilisateurs) > 1:
        return {"erreur": "Plusieurs comptes trouvés pour cet email, précisez etablissement_id"}, 409

    utilisateur = utilisateurs[0] if utilisateurs else None

    if not utilisateur or not utilisateur.check_password(password):
        return {"erreur": "Email ou mot de passe incorrect"}, 401

    if not utilisateur.actif:
        return {"erreur": "Compte désactivé"}, 403

    if utilisateur.mot_de_passe_expire():
        return {
            "erreur": "Mot de passe temporaire expiré. Contactez votre administrateur "
                      "pour obtenir un nouveau mot de passe."
        }, 403

    # Générer les tokens : identity = user_id (string, requis par flask-jwt-extended),
    # role/etablissement_id passent en additional_claims
    claims = _build_claims(utilisateur)
    access_expires, refresh_expires = _token_lifetimes()

    access_token = create_access_token(
        identity=str(utilisateur.id),
        additional_claims=claims,
        expires_delta=access_expires
    )

    refresh_token_str = create_refresh_token(
        identity=str(utilisateur.id),
        additional_claims=claims,
        expires_delta=refresh_expires
    )

    # Ne stocker que le hash du refresh token en base (jamais le token en clair)
    utilisateur.set_refresh_token(refresh_token_str, datetime.utcnow() + refresh_expires)
    utilisateur.dernier_login = datetime.utcnow()

    db.session.commit()

    return {
        'access_token': access_token,
        'refresh_token': refresh_token_str,
        'utilisateur': utilisateur.to_dict()
    }, 200


def refresh_token(user_id, presented_refresh_token):
    """
    Génère un nouveau access token ET un nouveau refresh token (ROTATION) à
    partir d'un refresh token valide.

    `user_id` vient de l'identity du JWT refresh déjà vérifié (signature +
    expiration) par @jwt_required(refresh=True) côté API. On vérifie EN PLUS
    que le token présenté correspond bien au hash stocké en base : c'est ce
    qui permet de détecter la réutilisation d'un refresh token déjà tourné
    (donc potentiellement volé) et de couper la session immédiatement.
    """
    utilisateur = Utilisateur.query.get(user_id)

    if not utilisateur:
        return {"erreur": "Refresh token invalide"}, 401

    if not utilisateur.actif:
        return {"erreur": "Compte désactivé"}, 403

    if not utilisateur.check_refresh_token(presented_refresh_token):
        # Le token présenté est valide (signature/expiration OK) mais ne
        # correspond plus au hash stocké : soit il a déjà été tourné et
        # réutilisé (vol probable), soit la session a été révoquée entre
        # temps (logout, changement de mot de passe, désactivation...).
        # Dans le doute, on révoque la session courante par précaution.
        utilisateur.revoke_refresh_token()
        db.session.commit()
        return {"erreur": "Refresh token invalide ou déjà utilisé"}, 401

    if utilisateur.refresh_token_expire_le < datetime.utcnow():
        return {"erreur": "Refresh token expiré"}, 401

    claims = _build_claims(utilisateur)
    access_expires, refresh_expires = _token_lifetimes()

    new_access_token = create_access_token(
        identity=str(utilisateur.id),
        additional_claims=claims,
        expires_delta=access_expires
    )
    new_refresh_token = create_refresh_token(
        identity=str(utilisateur.id),
        additional_claims=claims,
        expires_delta=refresh_expires
    )

    # Rotation : l'ancien refresh token devient immédiatement inutilisable.
    utilisateur.set_refresh_token(new_refresh_token, datetime.utcnow() + refresh_expires)
    db.session.commit()

    return {'access_token': new_access_token, 'refresh_token': new_refresh_token}, 200


def logout(user_id, access_jti=None, access_exp_timestamp=None):
    """
    Déconnexion : révoque le refresh token stocké pour cet utilisateur (donc
    plus aucun /refresh possible avec l'ancienne session), et met l'access
    token courant en liste noire (TokenBlocklist) pour qu'il soit rejeté
    immédiatement par les routes protégées, sans attendre son expiration
    naturelle (jusqu'à JWT_ACCESS_TOKEN_EXPIRES sinon).
    """
    utilisateur = Utilisateur.query.get(user_id)

    if utilisateur:
        utilisateur.revoke_refresh_token()

    if access_jti and access_exp_timestamp:
        TokenBlocklist.revoquer(
            access_jti, 'access', datetime.utcfromtimestamp(access_exp_timestamp)
        )

    db.session.commit()

    return {"message": "Déconnexion réussie"}, 200


def get_all_utilisateurs(etablissement_id=None, role=None):
    """
    Récupère tous les utilisateurs avec filtres optionnels
    """
    query = Utilisateur.query

    if etablissement_id:
        query = query.filter_by(etablissement_id=etablissement_id)

    if role:
        query = query.join(Role).filter(Role.libelle == role)

    return [u.to_dict() for u in query.all()]


def get_utilisateur_by_id(user_id):
    """Récupère un utilisateur par son ID"""
    return Utilisateur.query.get(user_id)


def update_utilisateur(user_id, data):
    """
    Met à jour un utilisateur
    """
    utilisateur = Utilisateur.query.get(user_id)

    if not utilisateur:
        return {"erreur": "Utilisateur non trouvé"}, 404

    if 'nom' in data:
        utilisateur.nom = data['nom']

    if 'etablissement_id' in data and data['etablissement_id']:
        etablissement = Etablissement.query.get(data['etablissement_id'])
        if not etablissement:
            return {"erreur": "Établissement invalide"}, 400
        utilisateur.etablissement_id = data['etablissement_id']

    if 'email' in data:
        # Vérifier l'unicité de l'email au sein de l'établissement (courant ou nouveau)
        existing = Utilisateur.query.filter(
            Utilisateur.email == data['email'],
            Utilisateur.id != user_id,
            Utilisateur.etablissement_id == utilisateur.etablissement_id
        ).first()

        if existing:
            return {"erreur": "Email déjà utilisé"}, 409

        utilisateur.email = data['email']

    if 'role_id' in data:
        role = Role.query.get(data['role_id'])
        if not role:
            return {"erreur": "Rôle invalide"}, 400
        utilisateur.role_id = data['role_id']

    if 'actif' in data:
        utilisateur.actif = data['actif']

    if 'password' in data:
        utilisateur.set_password(data['password'])

    try:
        db.session.commit()
        return utilisateur.to_dict(), 200
    except IntegrityError:
        db.session.rollback()
        return {"erreur": "Violation de contrainte d'unicité"}, 409
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la mise à jour"}, 500


def delete_utilisateur(user_id):
    """
    Supprime (désactive) un utilisateur
    """
    utilisateur = Utilisateur.query.get(user_id)

    if not utilisateur:
        return {"erreur": "Utilisateur non trouvé"}, 404

    # Soft delete : on désactive au lieu de supprimer
    utilisateur.actif = False
    utilisateur.revoke_refresh_token()

    try:
        db.session.commit()
        return {"message": "Utilisateur désactivé avec succès"}, 200
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la désactivation"}, 500


def change_password(user_id, old_password, new_password):
    """
    Change le mot de passe d'un utilisateur
    """
    utilisateur = Utilisateur.query.get(user_id)

    if not utilisateur:
        return {"erreur": "Utilisateur non trouvé"}, 404

    if not utilisateur.check_password(old_password):
        return {"erreur": "Ancien mot de passe incorrect"}, 401

    valide, message = valider_force_mot_de_passe(new_password)
    if not valide:
        return {"erreur": message}, 400

    utilisateur.set_password(new_password)
    utilisateur.doit_changer_mdp = False
    utilisateur.mdp_expire_le = None
    # Un changement de mot de passe doit invalider les sessions existantes
    # (ex : compte compromis, mot de passe changé volontairement après un
    # doute) — l'utilisateur devra se reconnecter, y compris sur cet appareil.
    utilisateur.revoke_refresh_token()

    try:
        db.session.commit()
        return {"message": "Mot de passe modifié avec succès"}, 200
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors du changement de mot de passe"}, 500


def reset_temp_password(user_id):
    """
    Régénère un mot de passe temporaire pour un utilisateur (ex : son précédent
    mot de passe temporaire a expiré sans avoir été utilisé, ou l'admin veut
    forcer un renouvellement). Invalide au passage sa session en cours.
    """
    utilisateur = Utilisateur.query.get(user_id)

    if not utilisateur:
        return {"erreur": "Utilisateur non trouvé"}, 404

    nouveau_mdp = generate_temp_password()
    utilisateur.set_password(nouveau_mdp)
    utilisateur.doit_changer_mdp = True
    utilisateur.mdp_expire_le = datetime.utcnow() + TEMP_PASSWORD_VALIDITY
    utilisateur.revoke_refresh_token()

    try:
        db.session.commit()
        result = utilisateur.to_dict()
        result['mot_de_passe_temporaire'] = nouveau_mdp
        return result, 200
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la réinitialisation du mot de passe"}, 500


# ============================================================================
# SUPERADMIN
# ============================================================================

def create_superadmin(data):
    """
    Crée un compte SuperAdmin (compte global, hors établissement).
    data: {nom, email, password}
    À réserver à un script d'initialisation / bootstrap : aucune route publique
    ne devrait permettre à un tiers non authentifié de créer un SuperAdmin.
    """
    try:
        existing = SuperAdmin.query.filter_by(email=data['email']).first()
        if existing:
            return {"erreur": "Un SuperAdmin avec cet email existe déjà"}, 409

        valide, message = valider_force_mot_de_passe(data.get('password', ''))
        if not valide:
            return {"erreur": message}, 400

        superadmin = SuperAdmin(
            nom=data['nom'],
            email=data['email'],
            actif=True
        )
        superadmin.set_password(data['password'])

        db.session.add(superadmin)
        db.session.commit()

        return superadmin.to_dict(), 201

    except IntegrityError:
        db.session.rollback()
        return {"erreur": "Violation de contrainte d'unicité"}, 409
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la création"}, 500


def login_superadmin(email, password):
    """
    Authentifie un SuperAdmin et génère les tokens JWT
    """
    superadmin = SuperAdmin.query.filter_by(email=email).first()

    if not superadmin or not superadmin.check_password(password):
        return {"erreur": "Email ou mot de passe incorrect"}, 401

    if not superadmin.actif:
        return {"erreur": "Compte désactivé"}, 403

    claims = _build_superadmin_claims(superadmin)
    access_expires, refresh_expires = _token_lifetimes()

    access_token = create_access_token(
        identity=str(superadmin.id),
        additional_claims=claims,
        expires_delta=access_expires
    )

    refresh_token_str = create_refresh_token(
        identity=str(superadmin.id),
        additional_claims=claims,
        expires_delta=refresh_expires
    )

    superadmin.set_refresh_token(refresh_token_str, datetime.utcnow() + refresh_expires)
    superadmin.dernier_login = datetime.utcnow()

    db.session.commit()

    return {
        'access_token': access_token,
        'refresh_token': refresh_token_str,
        'superadmin': superadmin.to_dict()
    }, 200


def refresh_superadmin_token(superadmin_id, presented_refresh_token):
    """
    Génère un nouveau access token + refresh token (ROTATION) SuperAdmin à
    partir d'un refresh token valide. Même logique de détection de
    réutilisation que refresh_token() ci-dessus.
    """
    superadmin = SuperAdmin.query.get(superadmin_id)

    if not superadmin:
        return {"erreur": "Refresh token invalide"}, 401

    if not superadmin.actif:
        return {"erreur": "Compte désactivé"}, 403

    if not superadmin.check_refresh_token(presented_refresh_token):
        superadmin.revoke_refresh_token()
        db.session.commit()
        return {"erreur": "Refresh token invalide ou déjà utilisé"}, 401

    if superadmin.refresh_token_expire_le < datetime.utcnow():
        return {"erreur": "Refresh token expiré"}, 401

    claims = _build_superadmin_claims(superadmin)
    access_expires, refresh_expires = _token_lifetimes()

    new_access_token = create_access_token(
        identity=str(superadmin.id),
        additional_claims=claims,
        expires_delta=access_expires
    )
    new_refresh_token = create_refresh_token(
        identity=str(superadmin.id),
        additional_claims=claims,
        expires_delta=refresh_expires
    )

    superadmin.set_refresh_token(new_refresh_token, datetime.utcnow() + refresh_expires)
    db.session.commit()

    return {'access_token': new_access_token, 'refresh_token': new_refresh_token}, 200


def logout_superadmin(superadmin_id, access_jti=None, access_exp_timestamp=None):
    """
    Révoque le refresh token SuperAdmin et met l'access token courant en
    liste noire (voir logout() ci-dessus pour le détail du raisonnement).
    """
    superadmin = SuperAdmin.query.get(superadmin_id)

    if superadmin:
        superadmin.revoke_refresh_token()

    if access_jti and access_exp_timestamp:
        TokenBlocklist.revoquer(
            access_jti, 'access', datetime.utcfromtimestamp(access_exp_timestamp)
        )

    db.session.commit()

    return {"message": "Déconnexion réussie"}, 200


def get_superadmin_by_id(superadmin_id):
    """Récupère un SuperAdmin par son ID"""
    return SuperAdmin.query.get(superadmin_id)


def change_password_superadmin(superadmin_id, old_password, new_password):
    """
    Change le mot de passe d'un SuperAdmin
    """
    superadmin = SuperAdmin.query.get(superadmin_id)

    if not superadmin:
        return {"erreur": "SuperAdmin non trouvé"}, 404

    if not superadmin.check_password(old_password):
        return {"erreur": "Ancien mot de passe incorrect"}, 401

    valide, message = valider_force_mot_de_passe(new_password)
    if not valide:
        return {"erreur": message}, 400

    superadmin.set_password(new_password)
    superadmin.revoke_refresh_token()

    try:
        db.session.commit()
        return {"message": "Mot de passe modifié avec succès"}, 200
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors du changement de mot de passe"}, 500