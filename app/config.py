import os
from datetime import timedelta
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.abspath(os.path.dirname(__file__))


def _parse_origins(raw):
    """Transforme 'https://a.com,https://b.com' en liste. Jamais de wildcard
    par défaut : une origine doit être explicitement autorisée."""
    if not raw:
        return []
    return [o.strip() for o in raw.split(",") if o.strip()]


class Config:
    """Configuration de base, commune à tous les environnements."""

    SECRET_KEY = os.environ.get("SECRET_KEY", "change-moi-en-production")

    # --- Base de données (MySQL) ---
    DB_USER = os.environ.get("DB_USER", "dan")
    DB_PASSWORD = os.environ.get("DB_PASSWORD", "dan")
    DB_HOST = os.environ.get("DB_HOST", "localhost")
    DB_PORT = os.environ.get("DB_PORT", "3306")
    DB_NAME = os.environ.get("DB_NAME", "gestionnairedb")

    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL",
        f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}",
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # --- JWT (Flask-JWT-Extended) ---
    JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "change-moi-aussi")

    # Durées de vie : source unique de vérité (les services lisent ces valeurs
    # via current_app.config, ne PAS les redéfinir en dur ailleurs).
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(minutes=15)
    JWT_REFRESH_TOKEN_EXPIRES = timedelta(days=30)

    # Tokens transportés en cookies httpOnly (jamais accessibles en JS), et
    # non plus dans le corps JSON / localStorage / sessionStorage. Ça élimine
    # le vol de token par XSS. En contrepartie on active la protection CSRF
    # (double-submit cookie) : le cookie CSRF (non httpOnly) doit être relu
    # par le JS et renvoyé dans le header ci-dessous à chaque requête d'état.
    JWT_TOKEN_LOCATION = ["cookies"]
    JWT_COOKIE_SECURE = os.environ.get("JWT_COOKIE_SECURE", "true").lower() == "true"
    JWT_COOKIE_SAMESITE = os.environ.get("JWT_COOKIE_SAMESITE", "Lax")
    JWT_COOKIE_CSRF_PROTECT = True
    JWT_ACCESS_CSRF_HEADER_NAME = "X-CSRF-TOKEN"
    JWT_REFRESH_CSRF_HEADER_NAME = "X-CSRF-TOKEN"
    JWT_ACCESS_COOKIE_PATH = "/api/"
    JWT_REFRESH_COOKIE_PATH = "/api/auth/refresh"
    JWT_COOKIE_DOMAIN = os.environ.get("JWT_COOKIE_DOMAIN") or None
    JWT_BLOCKLIST_ENABLED = True
    JWT_BLOCKLIST_TOKEN_CHECKS = ["access", "refresh"]

    # --- CORS ---
    # Jamais de "*" : liste blanche explicite, nécessaire dès lors que les
    # cookies (credentials) sont utilisés pour transporter les JWT.
    CORS_ORIGINS = _parse_origins(os.environ.get("CORS_ORIGINS", "http://localhost:5000"))
    CORS_SUPPORTS_CREDENTIALS = True

    # --- Rate limiting (Flask-Limiter) ---
    RATELIMIT_STORAGE_URI = os.environ.get("RATELIMIT_STORAGE_URI", "memory://")
    RATELIMIT_DEFAULT = "200 per hour"
    # Limites dédiées aux routes sensibles (brute-force login)
    RATELIMIT_LOGIN = os.environ.get("RATELIMIT_LOGIN", "5 per minute")
    RATELIMIT_REFRESH = os.environ.get("RATELIMIT_REFRESH", "30 per hour")

    # --- Politique de mot de passe ---
    PASSWORD_MIN_LENGTH = 8

    # --- Stockage des bulletins PDF (voir note N2 du module Evaluation) ---
    BULLETINS_STORAGE_PATH = os.environ.get(
        "BULLETINS_STORAGE_PATH", os.path.join(BASE_DIR, "storage", "bulletins")
    )

    @classmethod
    def validate(cls):
        """À appeler explicitement au démarrage de l'application (voir app.py) :
        échoue immédiatement (plutôt qu'un fallback silencieux et prévisible)
        si des secrets critiques n'ont pas été surchargés par l'environnement."""
        errors = []
        if cls.SECRET_KEY == "change-moi-en-production":
            errors.append("SECRET_KEY n'est pas défini (variable d'env SECRET_KEY manquante)")
        if cls.JWT_SECRET_KEY == "change-moi-aussi":
            errors.append("JWT_SECRET_KEY n'est pas défini (variable d'env JWT_SECRET_KEY manquante)")
        if not cls.CORS_ORIGINS:
            errors.append("CORS_ORIGINS est vide : aucune origine ne pourra appeler l'API depuis un navigateur")
        if errors:
            raise RuntimeError(
                "Configuration invalide pour un déploiement sécurisé :\n- " + "\n- ".join(errors)
            )


class DevelopmentConfig(Config):
    DEBUG = True
    SQLALCHEMY_ECHO = False
    # En dev uniquement : autorise les cookies JWT sur http:// (sans TLS).
    JWT_COOKIE_SECURE = os.environ.get("JWT_COOKIE_SECURE", "false").lower() == "true"


class TestingConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(minutes=5)
    JWT_COOKIE_SECURE = False
    RATELIMIT_ENABLED = False


class ProductionConfig(Config):
    DEBUG = False
    JWT_COOKIE_SECURE = True
    # En production, DATABASE_URL, SECRET_KEY, JWT_SECRET_KEY et CORS_ORIGINS
    # doivent obligatoirement venir des variables d'environnement.
    # Appeler ProductionConfig.validate() au démarrage (voir app.py) pour
    # échouer immédiatement si l'une de ces valeurs a été oubliée.


config_by_name = {
    "development": DevelopmentConfig,
    "testing": TestingConfig,
    "production": ProductionConfig,
}