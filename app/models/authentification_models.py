import bcrypt
import hashlib
import re
import secrets
import string
from datetime import datetime
from extensions import db

# Durée de validité d'un mot de passe temporaire (généré à la création d'un
# Utilisateur, ou lors d'une réinitialisation) avant qu'il ne soit plus utilisable.
TEMP_PASSWORD_VALIDITY_HOURS = 48

PASSWORD_MIN_LENGTH = 8


def generate_temp_password(length=10):
    """Génère un mot de passe temporaire aléatoire (lettres + chiffres),
    suffisamment lisible pour être communiqué manuellement à l'utilisateur."""
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def valider_force_mot_de_passe(password):
    """Valide un mot de passe fourni explicitement par un appelant (création
    d'utilisateur avec mot de passe imposé, changement de mot de passe, etc.).

    Les mots de passe TEMPORAIRES générés par generate_temp_password() n'ont
    pas besoin de passer par cette validation : ils sont aléatoires et à usage
    unique, donc leur "force" n'est pas le facteur de risque pertinent.

    Retourne (bool valide, str message_erreur_ou_None).
    """
    if not password or len(password) < PASSWORD_MIN_LENGTH:
        return False, f"Le mot de passe doit contenir au moins {PASSWORD_MIN_LENGTH} caractères"
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
    """Factorise la logique commune d'authentification (mot de passe + refresh token)
    partagée par Utilisateur et SuperAdmin. Les classes qui l'utilisent doivent définir
    les colonnes mot_de_passe_hash, refresh_token_hash, refresh_token_expire_le."""

    def set_password(self, password):
        """Hash et stocke le mot de passe avec bcrypt"""
        salt = bcrypt.gensalt()
        hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
        self.mot_de_passe_hash = hashed.decode('utf-8')

    def check_password(self, password):
        """Vérifie le mot de passe avec bcrypt"""
        if not self.mot_de_passe_hash:
            return False
        return bcrypt.checkpw(
            password.encode('utf-8'),
            self.mot_de_passe_hash.encode('utf-8')
        )

    def set_refresh_token(self, token, expire_le):
        """Stocke uniquement le hash du refresh token (jamais le token en clair)"""
        self.refresh_token_hash = hash_token(token)
        self.refresh_token_expire_le = expire_le

    def check_refresh_token(self, token):
        """Compare le hash du token présenté avec le hash stocké"""
        if not self.refresh_token_hash:
            return False
        return self.refresh_token_hash == hash_token(token)

    def revoke_refresh_token(self):
        self.refresh_token_hash = None
        self.refresh_token_expire_le = None


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


class Role(db.Model):
    __tablename__ = 'role'

    id = db.Column(db.Integer, primary_key=True)
    libelle = db.Column(db.String(50), unique=True, nullable=False)

    # Relation avec Utilisateur
    utilisateurs = db.relationship('Utilisateur', backref='role', lazy=True)

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
    email = db.Column(db.String(150), nullable=False)
    # Hash bcrypt : toujours 60 caractères, String(255) laisse de la marge
    mot_de_passe_hash = db.Column(db.String(255), nullable=False)
    role_id = db.Column(db.Integer, db.ForeignKey('role.id'), nullable=False)
    actif = db.Column(db.Boolean, default=True)

    # Authentification JWT
    # L'access token (courte durée) n'est jamais stocké en base : il est régénéré
    # à la volée au login/refresh et vérifié via sa signature.
    # Seul le hash du refresh token (longue durée) est persisté ici, pour permettre
    # sa révocation sans exposer le token en clair en cas de fuite de la base.
    refresh_token_hash = db.Column(db.String(255), nullable=True)
    refresh_token_expire_le = db.Column(db.DateTime, nullable=True)
    dernier_login = db.Column(db.DateTime, nullable=True)

    # Mot de passe temporaire : forcé à True à la création (le SuperAdmin ou l'Admin
    # d'établissement génère un mot de passe éphémère pour le nouvel utilisateur).
    # Repasse à False dès que l'utilisateur choisit lui-même son mot de passe
    # via /change-password. mdp_expire_le fixe la limite de 48h au-delà de laquelle
    # ce mot de passe temporaire n'est plus utilisable pour se connecter.
    doit_changer_mdp = db.Column(db.Boolean, default=True, nullable=False)
    mdp_expire_le = db.Column(db.DateTime, nullable=True)

    # Contrainte unique : (etablissement_id, email)
    __table_args__ = (
        db.UniqueConstraint('etablissement_id', 'email', name='uq_utilisateur_email_etablissement'),
    )

    # Relation avec Etablissement
    etablissement = db.relationship('Etablissement', backref='utilisateurs', lazy=True)

    def to_dict(self):
        data = {
            'id': self.id,
            'etablissement_id': self.etablissement_id,
            'nom': self.nom,
            'email': self.email,
            'role_id': self.role_id,
            'role': self.role.to_dict() if self.role else None,
            'actif': self.actif,
            'dernier_login': self.dernier_login.isoformat() if self.dernier_login else None,
            'doit_changer_mdp': self.doit_changer_mdp,
            'mdp_expire_le': self.mdp_expire_le.isoformat() if self.mdp_expire_le else None
        }
        if self.etablissement:
            data['etablissement_nom'] = self.etablissement.nom
        return data

    def mot_de_passe_expire(self):
        """True si le mot de passe temporaire a dépassé les 48h sans avoir été changé.
        Un mot de passe définitif (doit_changer_mdp=False) n'expire jamais."""
        return bool(
            self.doit_changer_mdp
            and self.mdp_expire_le
            and datetime.utcnow() > self.mdp_expire_le
        )


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

    # Authentification JWT (mêmes règles que pour Utilisateur)
    refresh_token_hash = db.Column(db.String(255), nullable=True)
    refresh_token_expire_le = db.Column(db.DateTime, nullable=True)
    dernier_login = db.Column(db.DateTime, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'nom': self.nom,
            'email': self.email,
            'actif': self.actif,
            'dernier_login': self.dernier_login.isoformat() if self.dernier_login else None
        }