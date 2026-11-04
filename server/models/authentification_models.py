import bcrypt
import hashlib
import re
import secrets
import string
from datetime import datetime, timedelta
from sqlalchemy import event, select
from extensions import db

# Durée de validité d'un mot de passe temporaire (généré à la création d'un
# Utilisateur, ou lors d'une réinitialisation) avant qu'il ne soit plus utilisable.
# S'applique aussi au PIN temporaire des Utilisateurs (cf. plus bas).
TEMP_PASSWORD_VALIDITY_HOURS = 48

PASSWORD_MIN_LENGTH = 8


# ---------------------------------------------------------------------------
# Connexion par CODE + PIN (Utilisateur uniquement ; le SuperAdmin garde
# email + mot de passe).
#
# - Code de connexion : 4 caractères, unique sur TOUTE la plateforme (il
#   suffit seul à retrouver le compte, donc l'établissement). Il n'est PAS
#   secret : il figure sur la fiche d'accès remise à la personne.
# - PIN : 4 chiffres, secret, stocké comme un mot de passe (hash bcrypt dans
#   mot_de_passe_hash). Le vrai rempart contre les essais au hasard est le
#   verrouillage du compte après MAX_ECHECS_CONNEXION échecs consécutifs.
#
# Alphabet sans caractères ambigus à l'oral ou à l'écrit (pas de 0/O, 1/I/L,
# 5/S) : 29 symboles, soit ~707 000 codes possibles.
# ---------------------------------------------------------------------------
CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789'
CODE_LENGTH = 4
PIN_LENGTH = 4

# Compteur PAR COMPTE, toutes IP confondues. Une même IP est déjà arrêtée
# plus tôt pour un code donné (RATELIMIT_LOGIN_ECHECS, config.py, 5 essais) :
# ce seuil plus haut ne se déclenche donc que face à des essais venant de
# plusieurs adresses, et un tiers isolé ne peut plus bloquer le compte d'autrui.
MAX_ECHECS_CONNEXION = 10
DUREE_VERROUILLAGE = timedelta(minutes=15)


def normaliser_code(code):
    """Code saisi -> forme canonique (majuscules, sans espaces ni tirets).
    Retourne None si le résultat n'a pas la forme d'un code valide."""
    if not isinstance(code, str):
        return None
    code = re.sub(r'[\s-]', '', code).upper()
    if len(code) != CODE_LENGTH or any(c not in CODE_ALPHABET for c in code):
        return None
    return code


def _code_aleatoire():
    return ''.join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def generer_code_unique(connection, colonne, max_essais=50):
    """Tire un code aléatoire absent de `colonne` (Utilisateur.code_connexion
    ou Etablissement.code). La contrainte UNIQUE en base reste le garde-fou
    final en cas de tirage simultané."""
    for _ in range(max_essais):
        code = _code_aleatoire()
        if connection.execute(select(colonne).where(colonne == code)).first() is None:
            return code
    raise RuntimeError("Impossible de générer un code unique : espace de codes saturé")


def pin_est_faible(pin):
    """PIN trop facile à deviner : chiffres tous identiques (0000), suite
    croissante ou décroissante (1234, 9876), motif répété (1212), ou
    colonne centrale du clavier (2580)."""
    chiffres = [int(c) for c in pin]
    ecarts = {b - a for a, b in zip(chiffres, chiffres[1:])}
    return (
        len(set(chiffres)) == 1
        or ecarts in ({1}, {-1})
        or pin[:2] == pin[2:]
        or pin in {'2580', '0852'}
    )


def valider_pin(pin):
    """Valide un PIN choisi par l'utilisateur. Retourne (bool, message)."""
    if not isinstance(pin, str) or not re.fullmatch(rf'\d{{{PIN_LENGTH}}}', pin):
        return False, f"Le code PIN doit contenir exactement {PIN_LENGTH} chiffres"
    if pin_est_faible(pin):
        return False, "Ce code PIN est trop facile à deviner (ex : 0000, 1234, 1212). Choisissez-en un autre"
    return True, None


def generate_temp_pin():
    """PIN temporaire aléatoire (jamais un PIN faible), à communiquer à la
    personne avec son code de connexion."""
    while True:
        pin = ''.join(secrets.choice(string.digits) for _ in range(PIN_LENGTH))
        if not pin_est_faible(pin):
            return pin


def valider_force_mot_de_passe(password):
    """Valide un mot de passe de SuperAdmin (création, changement de mot de
    passe). Les Utilisateurs n'ont pas de mot de passe mais un PIN, validé
    par valider_pin().

    Retourne (bool valide, str message_erreur_ou_None).
    """
    if not password or len(password) < PASSWORD_MIN_LENGTH:
        return False, f"Le mot de passe doit contenir au moins {PASSWORD_MIN_LENGTH} caractères"
    if len(password.encode('utf-8')) > 72:
        # Limite de bcrypt (au-delà, bcrypt >= 5 lève une erreur).
        return False, "Le mot de passe ne doit pas dépasser 72 octets"
    if not re.search(r'[A-Za-z]', password):
        return False, "Le mot de passe doit contenir au moins une lettre"
    if not re.search(r'[0-9]', password):
        return False, "Le mot de passe doit contenir au moins un chiffre"
    return True, None


def hash_token(token):
    """Hash déterministe (SHA-256) d'un token JWT, pour stockage et recherche en base.

    Contrairement à bcrypt (salé, donc impossible à retrouver par égalité), ce hash
    permet de retrouver l'enregistrement correspondant au refresh token présenté sur
    /refresh ou /logout, sans jamais conserver le token en clair en base (protection
    en cas de fuite de la base, cf. note du diagramme)."""
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


class AuthentifiableMixin:
    """Factorise la vérification du secret (mot de passe / PIN) partagée par
    Utilisateur et SuperAdmin, qui doivent définir la colonne
    mot_de_passe_hash. Les refresh tokens vivent dans SessionConnexion."""

    def set_password(self, password):
        """Hash et stocke le mot de passe avec bcrypt"""
        salt = bcrypt.gensalt()
        hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
        self.mot_de_passe_hash = hashed.decode('utf-8')

    def check_password(self, password):
        """Vérifie le mot de passe avec bcrypt"""
        if not self.mot_de_passe_hash:
            return False
        secret = password.encode('utf-8')
        if len(secret) > 72:
            # bcrypt >= 5 lève une ValueError au-delà de 72 octets : un tel
            # secret ne peut de toute façon pas avoir été enregistré.
            return False
        return bcrypt.checkpw(secret, self.mot_de_passe_hash.encode('utf-8'))


class SessionConnexion(db.Model):
    """Une session ouverte = un appareil/navigateur connecté. Remplace
    l'ancien refresh token UNIQUE par compte, qui faisait qu'une connexion
    sur le téléphone déconnectait le PC (et inversement).

    Le refresh token porte le claim 'sid' (identifiant de session) ; seul son
    hash est stocké. Rotation à chaque /refresh : token_hash prend la nouvelle
    valeur, l'ancienne passe dans token_precedent_hash. Présenter l'ancien
    token :
      - dans les DELAI_GRACE_ROTATION secondes suivant la rotation : deux
        onglets ont rafraîchi en même temps, c'est légitime ;
      - plus tard : réutilisation d'un token déjà tourné (vol probable), la
        session est fermée — et elle seule, pas celles des autres appareils.
    """
    __tablename__ = 'session_connexion'

    id = db.Column(db.Integer, primary_key=True)
    sid = db.Column(db.String(32), nullable=False, unique=True, index=True)
    # 'utilisateur' | 'superadmin' : les ids des deux tables se chevauchent.
    type_compte = db.Column(db.String(16), nullable=False)
    compte_id = db.Column(db.Integer, nullable=False)
    token_hash = db.Column(db.String(64), nullable=False)
    token_precedent_hash = db.Column(db.String(64), nullable=True)
    rotation_le = db.Column(db.DateTime, nullable=True)
    cree_le = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    expire_le = db.Column(db.DateTime, nullable=False)

    __table_args__ = (
        db.Index('ix_session_connexion_compte', 'type_compte', 'compte_id'),
    )

    DELAI_GRACE_ROTATION = timedelta(seconds=30)

    @staticmethod
    def nouveau_sid():
        return secrets.token_hex(16)

    @staticmethod
    def fermer_toutes(type_compte, compte_id, sauf_sid=None):
        """Ferme toutes les sessions d'un compte (désactivation, PIN
        réinitialisé ou changé…), éventuellement sauf la session courante.
        Ne committe pas."""
        query = SessionConnexion.query.filter_by(type_compte=type_compte, compte_id=compte_id)
        if sauf_sid:
            query = query.filter(SessionConnexion.sid != sauf_sid)
        query.delete(synchronize_session=False)

    @staticmethod
    def purger_expirees(type_compte, compte_id):
        SessionConnexion.query.filter(
            SessionConnexion.type_compte == type_compte,
            SessionConnexion.compte_id == compte_id,
            SessionConnexion.expire_le < datetime.utcnow(),
        ).delete(synchronize_session=False)


class TokenBlocklist(db.Model):
    """Liste noire des JTI (identifiants uniques de JWT) explicitement révoqués.

    Nécessaire car un access token classique reste valide jusqu'à son
    expiration naturelle même après un logout, une désactivation de compte ou
    un changement de mot de passe. On y ajoute le jti au moment du logout (et
    potentiellement lors d'une désactivation forcée) ; le callback
    `token_in_blocklist_loader` (voir authentification_api.py) est consulté à
    chaque requête protégée par @jwt_required().

    Les lignes expirées peuvent être purgées périodiquement (cron / tâche
    planifiée) via TokenBlocklist.purger_expires().
    """
    __tablename__ = 'token_blocklist'

    id = db.Column(db.Integer, primary_key=True)
    jti = db.Column(db.String(36), nullable=False, unique=True, index=True)
    type = db.Column(db.String(16), nullable=False)  # 'access' | 'refresh'
    revoque_le = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    expire_le = db.Column(db.DateTime, nullable=False)

    @staticmethod
    def est_revoque(jti):
        return db.session.query(
            TokenBlocklist.query.filter_by(jti=jti).exists()
        ).scalar()

    @staticmethod
    def revoquer(jti, token_type, expire_le):
        if jti and not TokenBlocklist.query.filter_by(jti=jti).first():
            db.session.add(TokenBlocklist(jti=jti, type=token_type, expire_le=expire_le))

    @staticmethod
    def purger_expires():
        """Supprime les entrées dont le token est de toute façon expiré
        (elles ne servent plus à rien, la vérification d'expiration du JWT
        suffit) : à appeler périodiquement pour éviter que la table ne grossisse."""
        TokenBlocklist.query.filter(TokenBlocklist.expire_le < datetime.utcnow()).delete()
        db.session.commit()


# Association N-N Utilisateur <-> Role : un même compte peut cumuler plusieurs
# rôles (ex : Censeur d'un niveau ET Enseignant de plusieurs classes, ou Admin
# d'établissement qui enseigne aussi). Le rôle sous lequel l'utilisateur
# travaille à un instant donné est le "rôle actif", porté par le claim 'role'
# du JWT (cf. authentification_services._build_claims) et choisi après le
# login via POST /api/auth/choisir-role.
utilisateur_role = db.Table(
    'utilisateur_role',
    db.Column('utilisateur_id', db.Integer, db.ForeignKey('utilisateur.id', ondelete='CASCADE'), primary_key=True),
    db.Column('role_id', db.Integer, db.ForeignKey('role.id'), primary_key=True),
)


class Role(db.Model):
    __tablename__ = 'role'

    id = db.Column(db.Integer, primary_key=True)
    libelle = db.Column(db.String(50), unique=True, nullable=False)

    def to_dict(self):
        return {
            'id': self.id,
            'libelle': self.libelle
        }

    @staticmethod
    def get_or_create(libelle):
        """Récupère ou crée un rôle par son libellé"""
        role = Role.query.filter_by(libelle=libelle).first()
        if not role:
            role = Role(libelle=libelle)
            db.session.add(role)
            db.session.commit()
        return role

    @staticmethod
    def init_roles():
        """Initialise les rôles par défaut.

        NB : 'Admin' est ici un rôle d'ÉTABLISSEMENT (l'utilisateur reste rattaché à
        un etablissement_id), à ne pas confondre avec SuperAdmin qui est un compte
        global d'administration de la plateforme, indépendant de tout établissement.
        """
        roles = [
            'Admin', 'Proviseur', 'Censeur', 'Surveillant',
            'Secretaire', 'Comptable', 'Infirmier', 'Enseignant', 'Parent'
        ]
        for role_libelle in roles:
            Role.get_or_create(role_libelle)


class Utilisateur(db.Model, AuthentifiableMixin):
    """Représente le personnel/parents rattachés à un établissement
    (Enseignant, Surveillant, Parent, Admin d'établissement, etc.)."""
    __tablename__ = 'utilisateur'

    id = db.Column(db.Integer, primary_key=True)
    # Obligatoire : un Utilisateur est toujours rattaché à un établissement.
    # Le compte d'administration globale (hors établissement) est porté par SuperAdmin.
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    nom = db.Column(db.String(100), nullable=False)
    # Identifiant de connexion (cf. CODE_ALPHABET plus haut) : unique sur
    # toute la plateforme, attribué automatiquement à l'insertion
    # (_attribuer_code_utilisateur ci-dessous), jamais modifiable par payload.
    code_connexion = db.Column(db.String(CODE_LENGTH), nullable=False)
    # Facultatif : la connexion se fait par code + PIN. Sert encore à
    # rattacher un nouveau rôle à un compte existant (multi-rôles).
    email = db.Column(db.String(150), nullable=True)
    # Hash bcrypt du PIN (4 chiffres). Toujours 60 caractères, String(255)
    # laisse de la marge. Nom de colonne historique (mot de passe).
    mot_de_passe_hash = db.Column(db.String(255), nullable=False)
    actif = db.Column(db.Boolean, default=True)

    # Verrouillage après MAX_ECHECS_CONNEXION PIN faux consécutifs, pendant
    # DUREE_VERROUILLAGE (ou jusqu'à une réinitialisation du PIN par un admin).
    echecs_connexion = db.Column(db.Integer, nullable=False, default=0, server_default='0')
    verrouille_jusqua = db.Column(db.DateTime, nullable=True)

    # Rôles cumulés de ce compte (au moins un). Remplace l'ancienne colonne
    # role_id (un seul rôle), cf. migration 'utilisateur_multi_roles'.
    roles = db.relationship(
        'Role', secondary=utilisateur_role, lazy='selectin',
        order_by='Role.id', backref=db.backref('utilisateurs', lazy=True)
    )

    # Authentification JWT : l'access token (courte durée) n'est jamais
    # stocké ; les refresh tokens (un par appareil) vivent dans
    # SessionConnexion, sous forme de hash.
    dernier_login = db.Column(db.DateTime, nullable=True)

    # Mot de passe temporaire : forcé à True à la création (le SuperAdmin ou l'Admin
    # d'établissement génère un mot de passe éphémère pour le nouvel utilisateur).
    # Repasse à False dès que l'utilisateur choisit lui-même son mot de passe
    # via /change-password. mdp_expire_le fixe la limite de 48h au-delà de laquelle
    # ce mot de passe temporaire n'est plus utilisable pour se connecter.
    doit_changer_mdp = db.Column(db.Boolean, default=True, nullable=False)
    mdp_expire_le = db.Column(db.DateTime, nullable=True)

    # Contraintes uniques : (etablissement_id, email) — plusieurs emails NULL
    # restent permis — et code de connexion sur toute la plateforme.
    __table_args__ = (
        db.UniqueConstraint('etablissement_id', 'email', name='uq_utilisateur_email_etablissement'),
        db.UniqueConstraint('code_connexion', name='uq_utilisateur_code_connexion'),
    )

    # Relation avec Etablissement
    etablissement = db.relationship('Etablissement', backref='utilisateurs', lazy=True)

    def to_dict(self):
        data = {
            'id': self.id,
            'etablissement_id': self.etablissement_id,
            'nom': self.nom,
            'code_connexion': self.code_connexion,
            'email': self.email,
            'roles': [r.to_dict() for r in self.roles],
            'actif': self.actif,
            'verrouille': self.est_verrouille(),
            'dernier_login': self.dernier_login.isoformat() if self.dernier_login else None,
            'doit_changer_mdp': self.doit_changer_mdp,
            'mdp_expire_le': self.mdp_expire_le.isoformat() if self.mdp_expire_le else None
        }
        if self.etablissement:
            data['etablissement_nom'] = self.etablissement.nom
        return data

    def libelles_roles(self):
        return [r.libelle for r in self.roles]

    def a_role(self, libelle):
        return libelle in self.libelles_roles()

    def mot_de_passe_expire(self):
        """True si le mot de passe temporaire a dépassé les 48h sans avoir été changé.
        Un mot de passe définitif (doit_changer_mdp=False) n'expire jamais."""
        return bool(
            self.doit_changer_mdp
            and self.mdp_expire_le
            and datetime.utcnow() > self.mdp_expire_le
        )

    def est_verrouille(self):
        return bool(self.verrouille_jusqua and datetime.utcnow() < self.verrouille_jusqua)

    def enregistrer_echec_connexion(self):
        """PIN faux : incrémente le compteur et verrouille le compte au
        MAX_ECHECS_CONNEXION-ième échec consécutif. Retourne True si le
        compte vient d'être verrouillé. Ne committe pas."""
        self.echecs_connexion = (self.echecs_connexion or 0) + 1
        if self.echecs_connexion >= MAX_ECHECS_CONNEXION:
            self.echecs_connexion = 0
            self.verrouille_jusqua = datetime.utcnow() + DUREE_VERROUILLAGE
            return True
        return False

    def deverrouiller(self):
        self.echecs_connexion = 0
        self.verrouille_jusqua = None


@event.listens_for(Utilisateur, 'before_insert')
def _attribuer_code_utilisateur(mapper, connection, utilisateur):
    """Tout Utilisateur reçoit son code de connexion à l'insertion, quel que
    soit le chemin de création (API, création composite Censeur/Surveillant,
    scripts de seed)."""
    if not utilisateur.code_connexion:
        utilisateur.code_connexion = generer_code_unique(connection, Utilisateur.code_connexion)


class SuperAdmin(db.Model, AuthentifiableMixin):
    """Compte d'administration globale de la plateforme, indépendant de tout
    établissement (pas d'etablissement_id). Gère les établissements eux-mêmes et
    la configuration générale de l'application.

    À ne pas confondre avec Utilisateur, qui représente le personnel/parents
    rattachés à un établissement (Enseignant, Surveillant, Parent, etc.)."""
    __tablename__ = 'super_admin'

    id = db.Column(db.Integer, primary_key=True)
    nom = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(150), unique=True, nullable=False)
    mot_de_passe_hash = db.Column(db.String(255), nullable=False)
    actif = db.Column(db.Boolean, default=True)

    # Sessions : cf. SessionConnexion (type_compte='superadmin').
    dernier_login = db.Column(db.DateTime, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'nom': self.nom,
            'email': self.email,
            'actif': self.actif,
            'dernier_login': self.dernier_login.isoformat() if self.dernier_login else None
        }