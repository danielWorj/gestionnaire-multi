import os
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from flask import Flask, jsonify, render_template, redirect, request, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

from config import config_by_name
from extensions import db, migrate, ma, jwt, cors, limiter
from api.structure_api import (
    cycle_bp, etablissement_bp, classe_bp,
    annee_scolaire_bp, trimestre_bp, sequence_bp,
    etablissement_logo_bp,
)
from api.pedagogie_api import (
    groupe_matiere_bp, matiere_bp, departement_bp, grade_bp, enseignant_bp,
    titulaire_classe_bp, matiere_classe_bp, censeur_bp, surveillant_bp,
    censeur_classe_bp, surveillant_classe_bp
)
from api.emploi_du_temps_api import creneau_horaire_bp, horaire_bp
from api.inscription_api import parent_bp, eleve_bp, inscription_bp, dossier_inscription_bp
from api.import_api import import_bp
# tranche_classe_bp / paiement_bp : suivi financier (échéancier par classe +
# année scolaire, versements), réservé à Admin/SuperAdmin/Comptable — cf.
# api/paiements_api.py. Renommé depuis tranche_paiement_bp -> tranche_classe_bp
# suite à la refonte TranchePaiement -> TrancheClasse (échéancier scopé au
# couple classe_id/annee_scolaire_id, cf. models/paiements_models.py) ; sans
# cet import à jour, /api/tranches-classe/ et /api/paiements/ n'existent pas
# (404 côté frontend paiements.html).
from api.paiements_api import tranche_classe_bp, paiement_bp
# enseignant_espace_bp : portail « mon espace » de l'enseignant connecté
# (/api/enseignant/mon-espace, /sequences, /roster). À NE PAS confondre avec
# pedagogie_api.enseignant_bp importé plus haut (/api/enseignants, gestion
# des comptes enseignants par l'Admin) : noms de blueprint distincts,
# sinon Flask lève ValueError au démarrage.
# censeur_espace_bp : « mon espace » du Censeur/Surveillant connecté
# (/api/censeur/mon-espace, /sequences, /roster) — strict pendant de
# enseignant_espace_bp, mais scopé par classes assignées. Alimente
# templates/censeur/notes.html et templates/censeur/bulletin.html.
from api.evaluation_api import note_bp, discipline_bp, enseignant_espace_bp, censeur_espace_bp
from api.bulletin_api import bulletin_bp
# audit_bp : consultation du journal d'audit (qui a modifié quoi, quand),
# alimenté automatiquement par services/audit_services.activer_audit().
from api.audit_api import audit_bp
# Supervision du réseau et comptes SuperAdmin (cf. api/superadmin_api.py).
from api.superadmin_api import superadmin_supervision_bp
from services.audit_services import activer_audit
from api.authentification_api import authentification_bp, superadmin_bp, enforce_password_change, enforce_role_actif

def create_app(env=None):
    """Application factory : construit et configure l'app Flask."""

    # Les templates (login.html, etablissements.html, ...) vivent dans
    # static/templates/ selon l'arborescence du projet.
    app = Flask(
        __name__,
        static_folder="static",
        template_folder="static/templates",
    )

    env = env or os.environ.get("FLASK_ENV", "development")
    config_cls = config_by_name[env]

    # Échoue immédiatement au démarrage en production si SECRET_KEY,
    # JWT_SECRET_KEY ou CORS_ORIGINS n'ont pas été correctement surchargés
    # par les variables d'environnement (voir Config.validate() dans config.py).
    if env == "production":
        config_cls.validate()

    app.config.from_object(config_cls)

    # Derrière nginx (un seul proxy de confiance) : request.remote_addr doit
    # être l'IP réelle du client, sinon Flask-Limiter compte TOUTES les
    # tentatives de login sous l'IP de nginx (5/min pour tout le monde).
    # TRUSTED_PROXIES=0 désactive le correctif (accès direct sans proxy).
    trusted_proxies = int(os.environ.get("TRUSTED_PROXIES", "0"))
    if trusted_proxies:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=trusted_proxies, x_proto=trusted_proxies, x_host=trusted_proxies)

    # --- Initialisation des extensions ---
    db.init_app(app)
    # Journal d'audit de toutes les écritures, dans la même transaction que
    # la donnée (cf. services/audit_services.py).
    activer_audit()
    migrate.init_app(app, db)
    ma.init_app(app)
    jwt.init_app(app)
    limiter.init_app(app)
    # supports_credentials=True est indispensable : les JWT voyagent désormais
    # en cookies httpOnly (voir config.py / authentification_api.py), le
    # navigateur ne les enverra que si les requêtes cross-origin sont
    # explicitement autorisées à inclure les credentials.
    cors.init_app(
        app,
        resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
        supports_credentials=True,
    )

    # Doit rester le PREMIER before_request : les preflight CORS (OPTIONS) ne
    # portent jamais de JWT et flask-jwt-extended ne pose aucun contexte pour
    # elles. Sans ce court-circuit, les before_request des blueprints
    # (get_jwt() dans structure_api, pedagogie_api, ...) levaient une
    # RuntimeError -> réponse 500 sans en-tête Access-Control-Allow-Origin,
    # et le navigateur bloquait toute écriture cross-origin.
    @app.before_request
    def answer_cors_preflight():
        if request.method == 'OPTIONS':
            return app.make_default_options_response()
        return None

    @app.before_request
    def enforce_api_security():
        if not request.path.startswith('/api/'):
            return None

        if request.method not in {'POST', 'PUT', 'PATCH'}:
            return None

        if request.content_length in (None, 0):
            return None

        content_type = request.mimetype or ''
        if content_type not in {'application/json', 'multipart/form-data'}:
            return jsonify({"erreur": "Format de données invalide pour cette API."}), 400

        return None

    @app.after_request
    def add_security_headers(response):
        response.headers.setdefault('X-Frame-Options', 'DENY')
        response.headers.setdefault('X-Content-Type-Options', 'nosniff')
        response.headers.setdefault('Referrer-Policy', 'no-referrer')
        if request.path.startswith('/api/'):
            # CSP stricte réservée aux réponses JSON : appliquée aux pages HTML
            # (login.html, etc.), default-src 'none' bloquait leurs CSS/JS.
            response.headers.setdefault('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; form-action 'self';")
            response.headers.setdefault('Cache-Control', 'no-store')
        return response

    @app.cli.command("init-roles")
    def init_roles_command():
        """Crée les rôles par défaut (Admin, Censeur, Enseignant, ...).
        Sans eux, aucune création d'Utilisateur n'est possible ("Rôle invalide")."""
        from models.authentification_models import Role
        Role.init_roles()
        print("Rôles initialisés.")

    # --- Enregistrement des blueprints ---
    app.register_blueprint(cycle_bp)
    app.register_blueprint(etablissement_bp)
    # Logos servis publiquement (balises <img>, sans en-tête d'authentification).
    app.register_blueprint(etablissement_logo_bp)
    app.register_blueprint(classe_bp)
    app.register_blueprint(annee_scolaire_bp)
    app.register_blueprint(trimestre_bp)
    app.register_blueprint(sequence_bp)
    app.register_blueprint(groupe_matiere_bp)
    app.register_blueprint(matiere_bp)
    app.register_blueprint(departement_bp)
    app.register_blueprint(grade_bp)
    app.register_blueprint(enseignant_bp)
    app.register_blueprint(titulaire_classe_bp)
    app.register_blueprint(matiere_classe_bp)
    app.register_blueprint(censeur_bp)
    app.register_blueprint(surveillant_bp)
    # Assignation Censeur/Surveillant ↔ Classe (réservée à Admin/SuperAdmin,
    # cf. pedagogie_api.py) : alimente le nouvel onglet "Responsables" de
    # configuration.html et détermine, via CenseurClasse/SurveillantClasse,
    # le périmètre effectivement accessible à un Censeur/Surveillant sur
    # titulaire_classe_bp, matiere_classe_bp, classe_bp et horaire_bp.
    app.register_blueprint(censeur_classe_bp)
    app.register_blueprint(surveillant_classe_bp)
    app.register_blueprint(creneau_horaire_bp)
    app.register_blueprint(horaire_bp)
    # Module Élèves & Inscriptions : gestion des parents, des élèves et de
    # leurs inscriptions (Admin/SuperAdmin/Secretaire en écriture ; Censeur/
    # Surveillant en lecture seule sur inscription_bp, restreints à leurs
    # classes assignées — cf. api/inscription_api.py).
    app.register_blueprint(parent_bp)
    app.register_blueprint(eleve_bp)
    app.register_blueprint(inscription_bp)
    app.register_blueprint(dossier_inscription_bp)
    # Import de masse des archives (CSV, Excel, Word) — cf. api/import_api.py.
    app.register_blueprint(import_bp)
    # Module Paiements : échéancier par classe (TrancheClasse) et versements
    # (Paiement + LignePaiement), Admin/SuperAdmin/Comptable — cf.
    # api/paiements_api.py. Sans ces deux lignes, /api/tranches-classe/ et
    # /api/paiements/ répondaient 404 (page paiements.html).
    app.register_blueprint(tranche_classe_bp)
    app.register_blueprint(paiement_bp)
    # Module Évaluation : notes (lecture pour Admin/SuperAdmin/Censeur/
    # Surveillant/Enseignant, écriture réservée à l'Enseignant titulaire) et
    # suivi disciplinaire (lecture+écriture Admin/SuperAdmin/Censeur/
    # Surveillant) — cf. api/evaluation_api.py. Oublié à l'enregistrement :
    # sans ce blueprint, /api/notes/ et /api/disciplines/ n'existaient pas.
    app.register_blueprint(note_bp)
    app.register_blueprint(discipline_bp)
    # Portail enseignant : alimente la page /enseignant/notes en
    # matières-classe attribuées, années/trimestres/séquences et listes
    # d'élèves — périmètre déduit du profil Enseignant connecté.
    app.register_blueprint(enseignant_espace_bp)
    # Portail Censeur/Surveillant : alimente /censeur/notes et
    # /censeur/bulletin en classes assignées, matières-classe, années/
    # trimestres/séquences et listes d'élèves — périmètre déduit de
    # resolve_classe_ids_restriction (cf. api/evaluation_api.py).
    app.register_blueprint(censeur_espace_bp)
    # Bulletins séquentiels / trimestriels / annuels (aperçu HTML + PDF).
    app.register_blueprint(bulletin_bp)
    app.register_blueprint(audit_bp)
    app.register_blueprint(authentification_bp)
    app.register_blueprint(superadmin_bp)
    app.register_blueprint(superadmin_supervision_bp)

    # Doit être enregistré ici (niveau app, pas blueprint) pour couvrir TOUTES
    # les routes API (structure_api.py compris) : tant qu'un Utilisateur a
    # doit_changer_mdp=True, seules /api/auth/change-password, /me, /logout et
    # /refresh restent accessibles (cf. ENDPOINTS_MDP_TEMPORAIRE_AUTORISES dans
    # api/authentification_api.py).
    app.before_request(enforce_password_change)
    # Rôle actif (multi-rôles) revérifié en direct à chaque requête : un rôle
    # retiré ou un compte désactivé coupe l'accès sans attendre l'expiration
    # du token (cf. enforce_role_actif dans api/authentification_api.py).
    app.before_request(enforce_role_actif)

    # --- Pages HTML (front) ---
    @app.route("/")
    def index():
        """Redirige vers la page de connexion.

        Les JWT voyagent désormais en cookies httpOnly (voir auth.js) : ce
        handler Flask ne peut pas non plus les lire lui-même (httpOnly =
        invisible côté serveur applicatif tout comme côté JS, seule la
        vérification de signature via @jwt_required y a accès). On redirige
        donc systématiquement vers /login ; sidebar.js appelle GestionnaireAuth
        .requireAuth() (qui interroge /api/auth/me) une fois la page chargée
        et redirige à nouveau si la session n'est en fait pas valide.
        """
        return redirect(url_for("login_page"))

    @app.route("/login")
    def login_page():
        """Sert la page de connexion (formulaire branché sur /api/auth/login)."""
        return render_template("login.html")

    @app.route("/change-password")
    def change_password_page():
        return render_template("admin/change-password.html")

    @app.route("/superadmin/login")
    def superadmin_login_page():
        return render_template("admin/login.html")
    @app.route("/superadmin/dashboard")
    def superadmin_dashboard_page():
        return render_template("admin/dashboard.html")
    @app.route("/superadmin/etablissements")
    def superadmin_etablissements_page():
        return render_template("admin/etablissements.html")

    #POUR LES ETABLISSEMENTS 
    @app.route("/dashboard")
    def dashboard_etablissement():
        return render_template("dashboard.html")
    @app.route("/configuration")
    def configuration_etablissement():
        return render_template("configuration.html")
    @app.route("/matiere")
    def matiere_etablissement():
        return render_template("matiere.html")
    @app.route("/enseignant")
    def enseignant_etablissement():
        return render_template("enseignant.html")
    @app.route("/emploi-du-temps")
    def emploi_du_temps_etablissement():
        return render_template("horaire.html")

    # --- Module Élèves & Inscriptions (3 pages distinctes) -----------------
    # L'ancienne route unique /eleves -> "eleves.html" a été éclatée en trois
    # écrans, un par ressource du module (cf. api/inscription_api.py :
    # parent_bp, eleve_bp, inscription_bp) :
    #
    #   /eleves        -> eleve.html        (répertoire des élèves)
    #   /parents       -> parent.html       (carnet des familles)
    #   /inscriptions  -> inscription.html  (registre + listes de classe)
    #
    # Les trois templates vivent dans static/templates/ comme les autres et
    # attendent, en plus de css/style.css : css/style-extras.css (panneaux
    # graphiques repliables, pagination, mise en page des listes imprimées).
    #
    # Aucune vérification de rôle ici, comme pour /configuration, /matiere,
    # etc. : sidebar.js (GestionnaireAuth.requireAuth) protège l'accès à la
    # page, et l'API renvoie les 403 qui font foi. C'est ce qui permet de
    # servir /inscriptions à un Censeur ou un Surveillant : le before_request
    # de inscription_bp le laisse lire (read_only_roles), et les données sont
    # déjà restreintes à ses classes assignées côté back
    # (resolve_classe_ids_restriction), tandis que ses tentatives d'écriture
    # se heurteront à un 403.
    @app.route("/eleves")
    def eleves_etablissement():
        return render_template("eleve.html")

    @app.route("/parents")
    def parents_etablissement():
        return render_template("parent.html")

    @app.route("/inscriptions")
    def inscriptions_etablissement():
        return render_template("inscription.html")
    
    @app.route("/paiements")
    def paiements_etablissement():
        return render_template("paiements.html")
    
    #POUR LE CENSEUR (périmètre restreint aux classes qui lui sont assignées,
    # cf. CenseurClasse dans pedagogie_models.py) : aucune vérification de
    # rôle ici, comme les autres routes de page ci-dessus — sidebar.js
    # (GestionnaireAuth.requireAuth) et les 403 renvoyés par l'API font déjà
    # ce travail côté client, même logique que /configuration, /matiere, etc.
    @app.route("/pedagogie")
    def pedagogie_censeur():
        return render_template("pedagogie.html")
    @app.route("/emploi-du-temps-censeur")
    def emploi_du_temps_censeur():
        return render_template("censeur/horaire.html")

    # Notes & discipline (consultation) et génération des bulletins, pour le
    # Censeur — périmètre restreint aux classes assignées, cf.
    # api/evaluation_api.py:censeur_espace_bp. Comme pour /pedagogie,
    # /emploi-du-temps-censeur, etc. : aucune vérification de rôle ici,
    # sidebar.js (GestionnaireAuth.requireAuth) et les 403 de l'API font foi.
    @app.route("/censeur/notes")
    def censeur_notes_page():
        return render_template("censeur/notes.html")

    @app.route("/censeur/bulletin")
    def censeur_bulletin_page():
        return render_template("censeur/bulletin.html")

    #POUR LE SURVEILLANT (même périmètre restreint aux classes assignées,
    # cf. SurveillantClasse) : réutilise le MÊME template que le Censeur
    # ci-dessus. censeur/horaire.html (ex-horaire_censeur.html, déplacé/
    # renommé) ne contient aucune logique dépendant du rôle exact — elle
    # affiche fidèlement ce que /api/horaires/ et /api/classes/ lui
    # renvoient, déjà filtrés côté back par rôle+profil_id (cf.
    # resolve_classe_ids_restriction) — seuls le titre de page et la
    # signature d'impression s'adaptent dynamiquement au rôle courant
    # (cf. <script> de censeur/horaire.html, GestionnaireAuth.getRole()).
    @app.route("/emploi-du-temps-surveillant")
    def emploi_du_temps_surveillant():
        return render_template("censeur/horaire.html")

    # Même périmètre restreint aux classes assignées (cf. SurveillantClasse) :
    # réutilise les MÊMES templates que le Censeur ci-dessus (censeur/notes.html,
    # censeur/bulletin.html) — ces pages n'ont aucune logique dépendant du rôle
    # exact, elles affichent fidèlement ce que /api/censeur/*, /api/notes/ et
    # /api/disciplines/ leur renvoient, déjà filtrés côté back par rôle+profil_id
    # (cf. resolve_classe_ids_restriction), même logique que
    # /emploi-du-temps-surveillant ci-dessus.
    @app.route("/surveillant/notes")
    def surveillant_notes_page():
        return render_template("censeur/notes.html")

    @app.route("/surveillant/bulletin")
    def surveillant_bulletin_page():
        return render_template("censeur/bulletin.html")

    #POUR L'ENSEIGNANT (portail dédié — distinct de /enseignant qui sert la
    # page Admin de gestion des comptes enseignants). Les routes ci-dessous
    # correspondent aux hrefs déclarés dans la section "Enseignant" de
    # sidebar.js (dashboard, notes, horaires, communiques, primes).
    #
    # ⚠️ HYPOTHÈSES à valider/ajuster :
    #   - Les templates sont supposés vivre dans
    #     static/templates/enseignant/ (même logique que static/templates/
    #     admin/ pour le SuperAdmin) : à créer s'ils n'existent pas encore.
    #   - Comme pour /configuration, /matiere, etc., aucune vérification de
    #     rôle n'est faite ici : sidebar.js (GestionnaireAuth.requireAuth)
    #     protège l'accès à la page, et l'API doit renvoyer les 403 qui font
    #     foi côté données (à confirmer : existe-t-il bien un rôle
    #     "Enseignant" reconnu par GestionnaireAuth.getRole() et par les
    #     before_request des blueprints concernés, ex. note_bp pour /notes ?).
    #   - "Primes" et "Communiqués" n'ont pas d'API associée dans les imports
    #     actuels (pas de prime_bp / communique_bp) : ces pages afficheront
    #     donc un template vide tant que le blueprint + les modèles
    #     correspondants n'existent pas côté back.
    @app.route("/enseignant/notes")
    def enseignant_notes_page():
        return render_template("enseignant/notes.html")

    @app.route("/enseignant/emploi-du-temps")
    def enseignant_horaires_page():
        return render_template("enseignant/horaire.html")

    # NB : /enseignant/dashboard, /communiques et /primes ont été retirées :
    # leurs templates n'ont jamais existé (500 TemplateNotFound). Le front
    # React (web/) couvre l'espace enseignant.


    @app.route("/api/health")
    def health_check():
        return jsonify({"status": "ok", "service": "gestion-scolaire-api"}), 200

    @app.errorhandler(404)
    def not_found(error):
        return jsonify({"erreur": "Ressource non trouvée"}), 404

    # Limites de Flask-Limiter (429) et de MAX_CONTENT_LENGTH (413) : même
    # format {"erreur": ...} que le reste de l'API, lisible par le front.
    @app.errorhandler(429)
    def too_many_requests(error):
        # error.description ne contient que la limite brute ("5 per 15
        # minute") : on n'affiche que le message explicite, s'il y en a un.
        message = getattr(getattr(error, "limit", None), "error_message", None)
        return jsonify({"erreur": message or "Trop de requêtes : réessayez dans quelques instants."}), 429

    @app.errorhandler(413)
    def payload_too_large(error):
        return jsonify({"erreur": "Fichier trop volumineux (20 Mo maximum par envoi)."}), 413

    @app.errorhandler(500)
    def internal_error(error):
        return jsonify({"erreur": "Erreur interne du serveur"}), 500

    return app


app = create_app()


if __name__ == "__main__":
    # Le débogueur Werkzeug (actif quand DEBUG=True) permet l'exécution de
    # code arbitraire si le serveur est exposé : ne jamais activer ce mode
    # par défaut si la config ne le précise pas explicitement.
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000")),
        debug=app.config.get("DEBUG", False),
    )