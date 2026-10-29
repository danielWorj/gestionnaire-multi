from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_marshmallow import Marshmallow
from flask_jwt_extended import JWTManager
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

db = SQLAlchemy()
migrate = Migrate()
ma = Marshmallow()
jwt = JWTManager()
cors = CORS()

# Rate limiting (anti brute-force sur /login, /refresh, etc.).
# La clé par défaut est l'IP ; à initialiser dans app.py avec :
#   limiter.init_app(app)
# storage_uri est lu depuis app.config["RATELIMIT_STORAGE_URI"] (memory:// en
# dev, redis:// en production pour que la limite tienne sur plusieurs workers).
limiter = Limiter(key_func=get_remote_address)