from models.inscription_models import Parent, Eleve, Inscription
from models.structure_models import Classe, AnneeScolaire
from extensions import db

# Les opérations CRUD "brutes" (create_entity, get_all_entities,
# get_entity_by_id, update_entity, delete_entity) sont 100% génériques : on
# les réutilise telles quelles comme brique de base des fonctions *_scoped
# ci-dessous — même logique que pedagogie_services.py et
# emploi_du_temps_services.py.
from services.structure_services import (
    create_entity, get_all_entities, get_entity_by_id, update_entity, delete_entity,
)


# ---------------------------------------------------------------------------
# Cloisonnement par établissement
#
# - Parent, Eleve portent une colonne etablissement_id directe
#   (DIRECT_SCOPE_MODELS) — même logique que Enseignant/GroupeMatiere/Matiere
#   dans pedagogie_models.py.
# - Inscription n'en porte pas : l'établissement propriétaire se déduit de
#   classe_id -> Classe.etablissement_id (INDIRECT, comme TitulaireClasse/
#   MatiereClasse dans pedagogie_services.py).
# ---------------------------------------------------------------------------

DIRECT_SCOPE_MODELS = (Parent, Eleve)
INDIRECT_SCOPE_MODELS = (Inscription,)


def get_etablissement_id_of(entity):
    """Retourne l'etablissement_id 'propriétaire' d'une entité de ce module."""
    if isinstance(entity, INDIRECT_SCOPE_MODELS):
        return entity.classe.etablissement_id
    return entity.etablissement_id  # Parent, Eleve


def scoped_query(model_class, etablissement_id, classe_ids_restriction=None):
    """Requête filtrée sur l'établissement, avec jointure sur Classe pour
    Inscription (pas de etablissement_id direct).

    classe_ids_restriction : None pour Admin/SuperAdmin/Secretaire (pas de
    restriction) ; pour un Censeur/Surveillant consultant en lecture seule
    (cf. inscription_api.py), le set() des classe_id qui lui ont été
    assignées — potentiellement vide, auquel cas la requête ne renvoie
    aucune Inscription plutôt que tout l'établissement. Sans effet sur
    Parent/Eleve (jamais restreints par classe, un Censeur/Surveillant n'y a
    de toute façon aucun accès direct — uniquement au travers des
    Inscription de ses classes)."""
    if model_class in DIRECT_SCOPE_MODELS:
        return model_class.query.filter_by(etablissement_id=etablissement_id)
    if model_class is Inscription:
        query = (
            Inscription.query
            .join(Classe, Inscription.classe_id == Classe.id)
            .filter(Classe.etablissement_id == etablissement_id)
        )
        if classe_ids_restriction is not None:
            query = query.filter(Inscription.classe_id.in_(classe_ids_restriction))
        return query
    raise ValueError(f"{model_class.__name__} n'est pas un modèle cloisonné par établissement")


def _validate_foreign_keys_scoped(model_class, data, etablissement_id):
    """Empêche un établissement de rattacher un élève à un parent, ou une
    inscription à un élève/une classe/une année scolaire, appartenant à un
    AUTRE établissement. Retourne un message d'erreur ou None si tout est
    valide."""

    if model_class is Eleve and 'parent_id' in data and data['parent_id'] is not None:
        parent = Parent.query.get(data['parent_id'])
        if not parent or parent.etablissement_id != etablissement_id:
            return "Parent invalide pour cet établissement"

    if model_class is Inscription:
        if 'eleve_id' in data:
            eleve = Eleve.query.get(data['eleve_id'])
            if not eleve or eleve.etablissement_id != etablissement_id:
                return "Élève invalide pour cet établissement"

        if 'classe_id' in data:
            classe = Classe.query.get(data['classe_id'])
            if not classe or classe.etablissement_id != etablissement_id:
                return "Classe invalide pour cet établissement"

        if 'annee_scolaire_id' in data:
            annee = AnneeScolaire.query.get(data['annee_scolaire_id'])
            if not annee or annee.etablissement_id != etablissement_id:
                return "Année scolaire invalide pour cet établissement"

    return None


def get_all_entities_scoped(model_class, etablissement_id, classe_ids_restriction=None):
    return [e.to_dict() for e in scoped_query(model_class, etablissement_id, classe_ids_restriction).all()]


def get_entity_scoped(model_class, entity_id, etablissement_id, classe_ids_restriction=None):
    """Renvoie None si l'entité n'existe pas, n'appartient pas à
    l'établissement, OU (pour une Inscription consultée par un
    Censeur/Surveillant) porte sur une classe hors de son périmètre assigné
    — sans distinguer ces cas côté API, pour ne pas révéler l'existence de
    ressources hors périmètre."""
    entity = db.session.get(model_class, entity_id)
    if not entity or get_etablissement_id_of(entity) != etablissement_id:
        return None
    if (model_class is Inscription and classe_ids_restriction is not None
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

    if model_class is Parent:
        for champ in ('nom', 'prenom', 'telephone', 'email'):
            if not data.get(champ):
                return {"erreur": f"{champ} requis"}, 400

    if model_class is Eleve:
        for champ in ('matricule', 'nom', 'prenom', 'sexe', 'lieu_naissance', 'parent_id'):
            if data.get(champ) in (None, ''):
                return {"erreur": f"{champ} requis"}, 400

    if model_class is Inscription:
        for champ in ('eleve_id', 'classe_id', 'annee_scolaire_id', 'date_inscription'):
            if data.get(champ) in (None, ''):
                return {"erreur": f"{champ} requis"}, 400

    error = _validate_foreign_keys_scoped(model_class, data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    if model_class is Inscription and classe_ids_restriction is not None:
        # Un Censeur/Surveillant est en lecture seule sur ce module (cf.
        # inscription_api.py, read_only_roles) : cette branche ne devrait en
        # pratique jamais être atteinte en création, mais on la garde par
        # cohérence défensive avec les autres modules *_services.py.
        classe_id = data.get('classe_id')
        if classe_id is None or int(classe_id) not in classe_ids_restriction:
            return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    return create_entity(model_class, data)


def update_entity_scoped(entity, data, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    data = dict(data or {})
    data.pop('etablissement_id', None)  # non modifiable, même par erreur de payload

    if isinstance(entity, Inscription) and classe_ids_restriction is not None:
        # L'entité existante est déjà dans le périmètre (garanti par
        # get_entity_scoped, appelé en amont côté API) ; on vérifie ICI en
        # plus la classe CIBLE, si le payload cherche à déplacer
        # l'inscription vers une autre classe hors périmètre.
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
    if (isinstance(entity, Inscription) and classe_ids_restriction is not None
            and entity.classe_id not in classe_ids_restriction):
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403
    return delete_entity(entity)