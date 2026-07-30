import os
from flask import Flask, jsonify, render_template, redirect, url_for

from config import config_by_name
from extensions import db, migrate, ma, jwt, cors, limiter
from api.structure_api import (
    cycle_bp, etablissement_bp, classe_bp,
    annee_scolaire_bp, trimestre_bp, sequence_bp
)
from api.pedagogie_api import (
    groupe_matiere_bp, matiere_bp, departement_bp, grade_bp, enseignant_bp,
    titulaire_classe_bp, matiere_classe_bp, censeur_bp, surveillant_bp,
    censeur_classe_bp, surveillant_classe_bp
)
from api.emploi_du_temps_api import creneau_horaire_bp, horaire_bp
from api.inscription_api import parent_bp, eleve_bp, inscription_bp
from api.authentification_api import authentification_bp, superadmin_bp, enforce_password_change

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

    # --- Initialisation des extensions ---
    db.init_app(app)
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


    # --- Enregistrement des blueprints ---
    app.register_blueprint(cycle_bp)
    app.register_blueprint(etablissement_bp)
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
    app.register_blueprint(authentification_bp)
    app.register_blueprint(superadmin_bp)

    # Doit être enregistré ici (niveau app, pas blueprint) pour couvrir TOUTES
    # les routes API (structure_api.py compris) : tant qu'un Utilisateur a
    # doit_changer_mdp=True, seules /api/auth/change-password, /me, /logout et
    # /refresh restent accessibles (cf. ENDPOINTS_MDP_TEMPORAIRE_AUTORISES dans
    # api/authentification_api.py).
    app.before_request(enforce_password_change)

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
        return render_template("horaire_censeur.html")

    #POUR LE SURVEILLANT (même périmètre restreint aux classes assignées,
    # cf. SurveillantClasse) : réutilise le MÊME template que le Censeur
    # ci-dessus. horaire_censeur.html ne contient aucune logique dépendant
    # du rôle exact — elle affiche fidèlement ce que /api/horaires/ et
    # /api/classes/ lui renvoient, déjà filtrés côté back par rôle+profil_id
    # (cf. resolve_classe_ids_restriction) — seuls le titre de page et la
    # signature d'impression s'adaptent dynamiquement au rôle courant
    # (cf. <script> de horaire_censeur.html, GestionnaireAuth.getRole()).
    @app.route("/emploi-du-temps-surveillant")
    def emploi_du_temps_surveillant():
        return render_template("horaire_censeur.html")


    @app.route("/api/health")
    def health_check():
        return jsonify({"status": "ok", "service": "gestion-scolaire-api"}), 200

    @app.errorhandler(404)
    def not_found(error):
        return jsonify({"erreur": "Ressource non trouvée"}), 404

    @app.errorhandler(500)
    def internal_error(error):
        return jsonify({"erreur": "Erreur interne du serveur"}), 500

    return app


if __name__ == "__main__":
    app = create_app()
    # Le débogueur Werkzeug (actif quand DEBUG=True) permet l'exécution de
    # code arbitraire si le serveur est exposé : ne jamais activer ce mode
    # par défaut si la config ne le précise pas explicitement.
    app.run(debug=app.config.get("DEBUG", False))