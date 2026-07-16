from models.pedagogie_models import (
    GroupeMatiere, Matiere, Enseignant, TitulaireClasse, MatiereClasse
)
from models.structure_models import Classe, AnneeScolaire
from extensions import db

# Les opérations CRUD "brutes" (create_entity, get_all_entities,
# get_entity_by_id, update_entity, delete_entity) sont 100% génériques
# (elles ne référencent aucun modèle de structure_models.py en particulier :
# elles lisent les colonnes du modèle passé en paramètre). On les réutilise
# donc telles quelles plutôt que de les dupliquer ici.
from services.structure_services import (
    create_entity, get_all_entities, get_entity_by_id, update_entity, delete_entity,
)


# ---------------------------------------------------------------------------
# Cloisonnement par établissement
#
# - Enseignant porte une colonne etablissement_id directe (DIRECT_SCOPE_MODELS)
# - TitulaireClasse / MatiereClasse n'en portent pas : l'établissement
#   propriétaire se déduit de classe_id -> Classe.etablissement_id
#   (cf. pedagogie_models.py)
# ---------------------------------------------------------------------------

DIRECT_SCOPE_MODELS = (Enseignant,)
INDIRECT_SCOPE_MODELS = (TitulaireClasse, MatiereClasse)


def get_etablissement_id_of(entity):
    """Retourne l'etablissement_id 'propriétaire' d'une entité pédagogique
    cloisonnée, quelle que soit sa profondeur de rattachement."""
    if isinstance(entity, INDIRECT_SCOPE_MODELS):
        return entity.classe.etablissement_id
    return entity.etablissement_id  # Enseignant


def scoped_query(model_class, etablissement_id):
    """Construit une requête filtrée sur l'établissement, avec jointure sur
    Classe pour les modèles qui n'ont pas de etablissement_id direct."""
    if model_class in DIRECT_SCOPE_MODELS:
        return model_class.query.filter_by(etablissement_id=etablissement_id)
    if model_class in INDIRECT_SCOPE_MODELS:
        return model_class.query.join(Classe, model_class.classe_id == Classe.id).filter(
            Classe.etablissement_id == etablissement_id
        )
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

    if 'enseignant_id' in data:
        enseignant = Enseignant.query.get(data['enseignant_id'])
        if not enseignant or enseignant.etablissement_id != etablissement_id:
            return "Enseignant invalide pour cet établissement"

    if model_class is TitulaireClasse and 'annee_scolaire_id' in data:
        annee = AnneeScolaire.query.get(data['annee_scolaire_id'])
        if not annee or annee.etablissement_id != etablissement_id:
            return "Année scolaire invalide pour cet établissement"

    if model_class is MatiereClasse and 'matiere_id' in data:
        # Matiere est un référentiel global, non cloisonné (cf. pedagogie_models.py) :
        # on vérifie seulement son existence, pas son établissement.
        if not Matiere.query.get(data['matiere_id']):
            return "Matière introuvable"

    return None


def get_all_entities_scoped(model_class, etablissement_id):
    return [e.to_dict() for e in scoped_query(model_class, etablissement_id).all()]


def get_entity_scoped(model_class, entity_id, etablissement_id):
    """Renvoie None si l'entité n'existe pas OU n'appartient pas à
    l'établissement (on ne distingue pas les deux cas côté API, pour ne pas
    révéler l'existence de ressources d'un autre établissement)."""
    entity = db.session.get(model_class, entity_id)
    if not entity or get_etablissement_id_of(entity) != etablissement_id:
        return None
    return entity


def create_entity_scoped(model_class, data, etablissement_id):
    data = dict(data or {})

    # Le etablissement_id ne vient JAMAIS du payload client : toujours forcé
    # depuis le contexte JWT (uniquement pour les modèles qui portent
    # réellement cette colonne).
    if model_class in DIRECT_SCOPE_MODELS:
        data['etablissement_id'] = etablissement_id

    error = _validate_foreign_keys_scoped(model_class, data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    return create_entity(model_class, data)


def update_entity_scoped(entity, data, etablissement_id):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    data = dict(data or {})
    data.pop('etablissement_id', None)  # non modifiable, même par erreur de payload

    error = _validate_foreign_keys_scoped(type(entity), data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    return update_entity(entity, data)


def delete_entity_scoped(entity, etablissement_id):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    return delete_entity(entity)