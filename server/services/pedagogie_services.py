from datetime import datetime, timedelta

from sqlalchemy.exc import IntegrityError

from models.pedagogie_models import (
    GroupeMatiere, Matiere, Enseignant, TitulaireClasse, MatiereClasse,
    Departement, Grade, Censeur, Surveillant, CenseurClasse, SurveillantClasse
)
from models.structure_models import Classe, AnneeScolaire
# Utilisé UNIQUEMENT par _creer_profil_avec_compte plus bas, pour créer en
# une seule transaction le profil (Censeur/Surveillant) ET son compte de
# connexion (Utilisateur) — cf. docstring de Censeur/Surveillant dans
# pedagogie_models.py. Pas de cycle : authentification_models.py n'importe
# rien de ce module ni de pedagogie_models.py.
from models.authentification_models import (
    Utilisateur, Role, generate_temp_password, TEMP_PASSWORD_VALIDITY_HOURS
)
from extensions import db

# Les opérations CRUD "brutes" (create_entity, get_all_entities,
# get_entity_by_id, update_entity, delete_entity) sont 100% génériques
# (elles ne référencent aucun modèle de structure_models.py en particulier :
# elles lisent les colonnes du modèle passé en paramètre). On les réutilise
# donc telles quelles plutôt que de les dupliquer ici.
from services.structure_services import (
    create_entity, get_all_entities, get_entity_by_id, update_entity, delete_entity,
)

# Même durée que pour tout Utilisateur (cf. authentification_models.py /
# authentification_services.py) : un seul et même mécanisme de mot de passe
# temporaire dans toute l'application.
TEMP_PASSWORD_VALIDITY = timedelta(hours=TEMP_PASSWORD_VALIDITY_HOURS)


# ---------------------------------------------------------------------------
# Cloisonnement par établissement
#
# - Enseignant, GroupeMatiere, Matiere, Departement, Grade portent une
#   colonne etablissement_id directe (DIRECT_SCOPE_MODELS)
# - TitulaireClasse / MatiereClasse n'en portent pas : l'établissement
#   propriétaire se déduit de classe_id -> Classe.etablissement_id
#   (cf. pedagogie_models.py)
# ---------------------------------------------------------------------------

DIRECT_SCOPE_MODELS = (Enseignant, GroupeMatiere, Matiere, Departement, Grade, Censeur, Surveillant)
# CenseurClasse/SurveillantClasse rejoignent TitulaireClasse/MatiereClasse :
# même logique de cloisonnement indirect (via classe_id -> Classe.etablissement_id),
# et les quatre modèles portent tous une colonne classe_id directe (utilisée
# par CLASSE_RESTREIGNABLE ci-dessous pour le filtrage par classes assignées).
INDIRECT_SCOPE_MODELS = (TitulaireClasse, MatiereClasse, CenseurClasse, SurveillantClasse)

# Sous-ensemble de INDIRECT_SCOPE_MODELS pour lequel un Censeur/Surveillant
# n'accède qu'aux classes qui lui ont été assignées (cf. resolve_classe_ids_restriction
# plus bas). CenseurClasse/SurveillantClasse en sont volontairement exclus :
# ce sont les tables d'assignation elles-mêmes, réservées à Admin/SuperAdmin
# (cf. pedagogie_api.py), donc jamais consultées avec une restriction non-None.
CLASSE_RESTREIGNABLE_MODELS = (TitulaireClasse, MatiereClasse)


def get_etablissement_id_of(entity):
    """Retourne l'etablissement_id 'propriétaire' d'une entité pédagogique
    cloisonnée, quelle que soit sa profondeur de rattachement."""
    if isinstance(entity, INDIRECT_SCOPE_MODELS):
        return entity.classe.etablissement_id
    return entity.etablissement_id  # Enseignant, GroupeMatiere, Matiere


def scoped_query(model_class, etablissement_id, classe_ids_restriction=None):
    """Construit une requête filtrée sur l'établissement, avec jointure sur
    Classe pour les modèles qui n'ont pas de etablissement_id direct.

    classe_ids_restriction : None pour Admin/SuperAdmin (pas de restriction
    supplémentaire, comportement inchangé) ; pour un Censeur/Surveillant, un
    set() des classe_id qui lui ont été assignées (cf.
    resolve_classe_ids_restriction plus bas) — potentiellement VIDE si aucune
    classe n'a encore été assignée, auquel cas la requête ne renvoie rien
    plutôt que tout l'établissement. Ignoré pour les modèles hors
    CLASSE_RESTREIGNABLE_MODELS (référentiels globaux, ou CenseurClasse/
    SurveillantClasse eux-mêmes)."""
    if model_class in DIRECT_SCOPE_MODELS:
        return model_class.query.filter_by(etablissement_id=etablissement_id)
    if model_class in INDIRECT_SCOPE_MODELS:
        query = model_class.query.join(Classe, model_class.classe_id == Classe.id).filter(
            Classe.etablissement_id == etablissement_id
        )
        if classe_ids_restriction is not None and model_class in CLASSE_RESTREIGNABLE_MODELS:
            query = query.filter(model_class.classe_id.in_(classe_ids_restriction))
        return query
    raise ValueError(f"{model_class.__name__} n'est pas un modèle cloisonné par établissement")


def _validate_foreign_keys_scoped(model_class, data, etablissement_id):
    """Empêche un établissement de rattacher une affectation pédagogique
    (titulaire de classe, matière-classe) à une classe, un enseignant ou une
    année scolaire appartenant à un AUTRE établissement. Retourne un message
    d'erreur ou None si tout est valide."""

    if 'classe_id' in data:
        classe = Classe.query.get(data['classe_id'])
        if not classe or classe.etablissement_id != etablissement_id:
            return "Classe invalide pour cet établissement"

    if model_class is Enseignant and 'departement_id' in data:
        departement = Departement.query.get(data['departement_id'])
        if not departement or departement.etablissement_id != etablissement_id:
            return "Département invalide pour cet établissement"

    if model_class is Enseignant and 'grade_id' in data:
        grade = Grade.query.get(data['grade_id'])
        if not grade or grade.etablissement_id != etablissement_id:
            return "Grade invalide pour cet établissement"

    if 'enseignant_id' in data:
        enseignant = Enseignant.query.get(data['enseignant_id'])
        if not enseignant or enseignant.etablissement_id != etablissement_id:
            return "Enseignant invalide pour cet établissement"

    if model_class is TitulaireClasse and 'annee_scolaire_id' in data:
        annee = AnneeScolaire.query.get(data['annee_scolaire_id'])
        if not annee or annee.etablissement_id != etablissement_id:
            return "Année scolaire invalide pour cet établissement"

    if model_class is Matiere and 'groupe_id' in data:
        groupe = GroupeMatiere.query.get(data['groupe_id'])
        if not groupe or groupe.etablissement_id != etablissement_id:
            return "Groupe de matières invalide pour cet établissement"

    if model_class is MatiereClasse and 'matiere_id' in data:
        # Matiere est désormais cloisonnée par établissement (cf.
        # pedagogie_models.py) : on vérifie qu'elle appartient bien à
        # l'établissement courant, pas seulement qu'elle existe.
        matiere = Matiere.query.get(data['matiere_id'])
        if not matiere or matiere.etablissement_id != etablissement_id:
            return "Matière invalide pour cet établissement"

    if model_class is CenseurClasse and 'censeur_id' in data:
        censeur = Censeur.query.get(data['censeur_id'])
        if not censeur or censeur.etablissement_id != etablissement_id:
            return "Censeur invalide pour cet établissement"

    if model_class is CenseurClasse and 'classe_id' in data:
        # Une classe n'a jamais plus d'un censeur responsable à la fois (cf.
        # uq_censeur_classe_unique_classe dans pedagogie_models.py) : on le
        # vérifie ici pour renvoyer un message clair plutôt que de laisser
        # remonter l'IntegrityError brute de la contrainte DB. Pas
        # d'équivalent pour SurveillantClasse : plusieurs Surveillants
        # peuvent partager une même classe.
        deja_assignee = CenseurClasse.query.filter_by(classe_id=data['classe_id']).first()
        if deja_assignee and deja_assignee.censeur_id != data.get('censeur_id'):
            return "Cette classe a déjà un censeur assigné"

    if model_class is SurveillantClasse and 'surveillant_id' in data:
        surveillant = Surveillant.query.get(data['surveillant_id'])
        if not surveillant or surveillant.etablissement_id != etablissement_id:
            return "Surveillant invalide pour cet établissement"

    return None


def get_all_entities_scoped(model_class, etablissement_id, classe_ids_restriction=None):
    return [e.to_dict() for e in scoped_query(model_class, etablissement_id, classe_ids_restriction).all()]


def get_entity_scoped(model_class, entity_id, etablissement_id, classe_ids_restriction=None):
    """Renvoie None si l'entité n'existe pas, n'appartient pas à
    l'établissement, OU (pour TitulaireClasse/MatiereClasse consultés par un
    Censeur/Surveillant) porte sur une classe hors de son périmètre assigné
    — dans tous les cas sans distinguer côté API, pour ne pas révéler
    l'existence de ressources hors périmètre."""
    entity = db.session.get(model_class, entity_id)
    if not entity or get_etablissement_id_of(entity) != etablissement_id:
        return None
    if (classe_ids_restriction is not None and model_class in CLASSE_RESTREIGNABLE_MODELS
            and entity.classe_id not in classe_ids_restriction):
        return None
    return entity


def create_entity_scoped(model_class, data, etablissement_id, classe_ids_restriction=None):
    data = dict(data or {})

    # Le etablissement_id ne vient JAMAIS du payload client : toujours forcé
    # depuis le contexte JWT (uniquement pour les modèles qui portent
    # réellement cette colonne).
    if model_class in DIRECT_SCOPE_MODELS:
        data['etablissement_id'] = etablissement_id

    error = _validate_foreign_keys_scoped(model_class, data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    if classe_ids_restriction is not None and model_class in CLASSE_RESTREIGNABLE_MODELS:
        classe_id = data.get('classe_id')
        if classe_id is None or int(classe_id) not in classe_ids_restriction:
            return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    return create_entity(model_class, data)


def update_entity_scoped(entity, data, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    data = dict(data or {})
    data.pop('etablissement_id', None)  # non modifiable, même par erreur de payload

    if classe_ids_restriction is not None and type(entity) in CLASSE_RESTREIGNABLE_MODELS:
        # L'entité existante est déjà dans le périmètre (garanti par
        # get_entity_scoped, appelé en amont côté API) ; on vérifie ICI en
        # plus la classe CIBLE, si le payload cherche à déplacer
        # l'affectation vers une autre classe hors périmètre.
        nouveau_classe_id = data.get('classe_id', entity.classe_id)
        if int(nouveau_classe_id) not in classe_ids_restriction:
            return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    error = _validate_foreign_keys_scoped(type(entity), data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    return update_entity(entity, data)


def delete_entity_scoped(entity, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    if (classe_ids_restriction is not None and type(entity) in CLASSE_RESTREIGNABLE_MODELS
            and entity.classe_id not in classe_ids_restriction):
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403
    return delete_entity(entity)


# ---------------------------------------------------------------------------
# Résolution du périmètre "classes assignées" pour un Censeur/Surveillant
#
# Utilisé par pedagogie_api.py (TitulaireClasse, MatiereClasse),
# emploi_du_temps_api.py (Horaire) et structure_api.py (Classe elle-même)
# pour appliquer un cloisonnement identique et centralisé. Chaque blueprint
# calcule ce set UNE FOIS par requête et le passe aux fonctions *_scoped
# ci-dessus.
#
# IMPORTANT — résolution TOUJOURS EN DIRECT depuis user_id, jamais depuis un
# claim mis en cache dans le JWT (ancien comportement : resolve_classe_ids_
# restriction(role, profil_id) où profil_id venait de claims['profil_id'],
# calculé UNE SEULE FOIS par authentification_services._build_claims, au
# login/refresh). Ce claim se figeait dans le token émis, et restait donc
# périmé pour toute la durée de vie de ce token si le profil métier était
# relié à son compte de connexion (ou une classe (re)assignée) APRÈS
# l'émission du token : la personne restait bloquée avec "aucune classe"
# jusqu'à sa prochaine reconnexion complète, alors même que la base de
# données était déjà à jour (symptôme observé : la classe apparaît dans
# configuration.html — qui lit la base directement — mais pas dans les
# pages du Censeur/Surveillant concerné, qui lisaient un token périmé).
#
# On résout donc désormais le profil (Censeur/Surveillant) à CHAQUE requête,
# via son user_id — celui-ci vient de get_jwt_identity(), qui est TOUJOURS
# fiable (c'est l'identité immuable du compte, jamais recalculée après
# création) contrairement à un claim métier dérivé et mis en cache. Le coût
# est une requête SQL supplémentaire par appel (filter_by sur une colonne
# indexée/unique), négligeable face au gain de fiabilité.
# ---------------------------------------------------------------------------

def get_classe_ids_assignees_censeur(censeur_id):
    """Ensemble des classe_id assignées à un Censeur donné (set vide si
    aucune, jamais None : None est réservé au sens "pas de restriction",
    utilisé uniquement pour Admin/SuperAdmin)."""
    return {cc.classe_id for cc in CenseurClasse.query.filter_by(censeur_id=censeur_id).all()}


def get_classe_ids_assignees_surveillant(surveillant_id):
    """Équivalent de get_classe_ids_assignees_censeur pour un Surveillant."""
    return {sc.classe_id for sc in SurveillantClasse.query.filter_by(surveillant_id=surveillant_id).all()}


def resolve_censeur_profil(user_id):
    """Résout EN DIRECT (pas de cache) le profil Censeur relié à ce compte
    de connexion, ou None si aucun (compte pas encore relié à un profil,
    ou rôle différent)."""
    if not user_id:
        return None
    return Censeur.query.filter_by(utilisateur_id=user_id).first()


def resolve_surveillant_profil(user_id):
    """Équivalent de resolve_censeur_profil pour un Surveillant."""
    if not user_id:
        return None
    return Surveillant.query.filter_by(utilisateur_id=user_id).first()


def resolve_enseignant_profil(user_id):
    """Équivalent de resolve_censeur_profil pour un Enseignant — AJOUTÉ pour
    le module Évaluation (cf. evaluation_service.py /
    Enseignant.utilisateur_id ci-dessus dans pedagogie_models.py) : résout EN
    DIRECT (pas de cache) le profil Enseignant relié à ce compte de
    connexion, ou None si aucun (compte pas encore relié à un profil, ou
    rôle différent)."""
    if not user_id:
        return None
    return Enseignant.query.filter_by(utilisateur_id=user_id).first()


def resolve_classe_ids_restriction(role, user_id):
    """Calcule la restriction de périmètre "classes" à appliquer pour
    l'utilisateur courant :
      - Admin / SuperAdmin -> None (pas de restriction : cloisonnement par
        etablissement_id seul, comportement inchangé)
      - Censeur / Surveillant -> un set() de classe_id, TOUJOURS résolu EN
        DIRECT depuis la base (via user_id -> Censeur/Surveillant.
        utilisateur_id -> CenseurClasse/SurveillantClasse), potentiellement
        vide si aucun profil n'est encore relié à ce compte, ou si aucune
        classe ne lui a encore été assignée : par prudence, on restreint
        systématiquement plutôt que d'ouvrir tout l'établissement par
        défaut en cas de donnée manquante.
      - tout autre rôle -> set() vide (non concerné par ces endpoints, mais
        par prudence aucun accès plutôt qu'un accès non filtré).

    `user_id` : l'identité du compte connecté (get_jwt_identity(), castée en
    int par l'appelant) — PAS un profil_id lu depuis les claims JWT, qui
    serait potentiellement périmé (cf. commentaire de section ci-dessus).
    Prend des valeurs simples (pas les claims JWT bruts, ni get_jwt()) pour
    que ce module reste indépendant du contexte Flask/JWT, comme le reste de
    ce fichier — c'est à l'appelant (couche API) d'extraire role/user_id et
    de les passer ici."""
    if role in ("Admin", "SuperAdmin"):
        return None
    if role == "Censeur":
        profil = resolve_censeur_profil(user_id)
        return get_classe_ids_assignees_censeur(profil.id) if profil else set()
    if role == "Surveillant":
        profil = resolve_surveillant_profil(user_id)
        return get_classe_ids_assignees_surveillant(profil.id) if profil else set()
    return set()


# ---------------------------------------------------------------------------
# Création composite Censeur/Surveillant + compte de connexion
#
# Remplace le workflow en 3 étapes (POST /api/censeurs, POST
# /api/auth/utilisateurs, PUT /api/censeurs/<id> pour lier utilisateur_id)
# par UNE SEULE opération transactionnelle : le profil "métier" (Censeur ou
# Surveillant) et son compte de connexion (Utilisateur, rôle correspondant)
# sont créés et reliés ensemble, avec mot de passe temporaire généré et
# doit_changer_mdp=True — même mécanisme que pour tout autre Utilisateur
# (cf. authentification_services.create_utilisateur), pour forcer le
# changement de mot de passe à la première connexion, comme pour un Admin ou
# un Enseignant.
#
# Les classes à assigner d'emblée sont optionnelles (data['classe_ids']) :
# le profil peut aussi être créé sans classe et complété plus tard via la
# modale d'assignation déjà existante (POST/DELETE /api/censeurs-classes/).
# ---------------------------------------------------------------------------

_ROLE_MODELS = {
    'Censeur': (Censeur, CenseurClasse, 'censeur_id'),
    'Surveillant': (Surveillant, SurveillantClasse, 'surveillant_id'),
}


def _creer_profil_avec_compte(role_libelle, data, etablissement_id):
    """role_libelle : 'Censeur' ou 'Surveillant'. data : {nom, prenom, email,
    telephone (optionnel), sexe (optionnel), classe_ids (optionnel, liste
    d'int)}. Retourne (résultat, status) — résultat contient le profil créé,
    le compte de connexion lié et le mot de passe temporaire en clair (une
    seule fois, comme create_utilisateur)."""
    model_class, liaison_class, cle_profil = _ROLE_MODELS[role_libelle]
    data = dict(data or {})

    for champ in ('nom', 'prenom', 'email'):
        if not data.get(champ):
            return {"erreur": f"{champ} requis"}, 400

    role = Role.query.filter_by(libelle=role_libelle).first()
    if not role:
        # Ne devrait jamais arriver (cf. Role.init_roles()), mais on
        # préfère un message explicite à une 500 muette.
        return {"erreur": f"Rôle '{role_libelle}' introuvable — avez-vous appelé Role.init_roles() ?"}, 500

    email = data['email']

    # Unicité du profil métier, globale — même règle que Enseignant.email
    # (cf. pedagogie_models.py).
    if model_class.query.filter_by(email=email).first():
        return {"erreur": f"Un {role_libelle.lower()} avec cet email existe déjà"}, 409

    # Unicité du compte de connexion — même contrainte que pour tout
    # Utilisateur (etablissement_id, email), cf. authentification_models.py.
    if Utilisateur.query.filter_by(email=email, etablissement_id=etablissement_id).first():
        return {"erreur": "Un compte de connexion avec cet email existe déjà dans cet établissement"}, 409

    # Validation des classes initiales à assigner (optionnelles).
    classe_ids = data.get('classe_ids') or []
    classes = []
    for classe_id in classe_ids:
        classe = Classe.query.get(classe_id)
        if not classe or classe.etablissement_id != etablissement_id:
            return {"erreur": f"Classe {classe_id} invalide pour cet établissement"}, 400
        classes.append(classe)

    if role_libelle == 'Censeur' and classe_ids:
        # Une classe n'a jamais plus d'un censeur (cf.
        # uq_censeur_classe_unique_classe) : on vérifie ici pour un message
        # clair plutôt qu'une IntegrityError brute au commit.
        deja_prises = (
            CenseurClasse.query.filter(CenseurClasse.classe_id.in_(classe_ids)).all()
        )
        if deja_prises:
            libelles = ", ".join(str(l.classe_id) for l in deja_prises)
            return {"erreur": f"Classe(s) déjà assignée(s) à un autre censeur : {libelles}"}, 409

    mot_de_passe = generate_temp_password()

    utilisateur = Utilisateur(
        # Utilisateur ne porte qu'un champ 'nom' (pas de prenom séparé,
        # contrairement à Censeur/Surveillant/Enseignant) : on y concatène
        # prénom + nom pour un affichage correct côté /api/auth/me.
        nom=f"{data['prenom']} {data['nom']}".strip(),
        email=email,
        role_id=role.id,
        etablissement_id=etablissement_id,
        actif=True,
        doit_changer_mdp=True,
        mdp_expire_le=datetime.utcnow() + TEMP_PASSWORD_VALIDITY,
    )
    utilisateur.set_password(mot_de_passe)

    profil = model_class(
        etablissement_id=etablissement_id,
        nom=data['nom'],
        prenom=data['prenom'],
        telephone=data.get('telephone'),
        email=email,
        sexe=data.get('sexe'),
    )
    # Résolu par SQLAlchemy au flush/commit (pas besoin de connaître
    # utilisateur.id à l'avance) : c'est ce qui rend l'ensemble atomique.
    profil.utilisateur = utilisateur

    try:
        db.session.add(utilisateur)
        db.session.add(profil)
        db.session.flush()  # attribue profil.id sans committer, pour les liaisons ci-dessous

        liaisons = [liaison_class(classe_id=c.id, **{cle_profil: profil.id}) for c in classes]
        db.session.add_all(liaisons)

        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return {"erreur": "Violation de contrainte d'unicité"}, 409
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la création"}, 500

    result = profil.to_dict()
    result['compte'] = utilisateur.to_dict()
    # Communiqué UNE SEULE FOIS ici, comme dans
    # authentification_services.create_utilisateur : le hash bcrypt n'est
    # pas réversible, ce mot de passe en clair ne sera plus jamais
    # récupérable ensuite.
    result['mot_de_passe_temporaire'] = mot_de_passe
    result['classe_ids'] = [c.id for c in classes]
    return result, 201


def create_censeur_avec_compte(data, etablissement_id):
    return _creer_profil_avec_compte('Censeur', data, etablissement_id)


def create_surveillant_avec_compte(data, etablissement_id):
    return _creer_profil_avec_compte('Surveillant', data, etablissement_id)