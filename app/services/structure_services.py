from models.structure_models import (
    Etablissement, Cycle, Classe, AnneeScolaire, Trimestre, Sequence
)
from extensions import db
from sqlalchemy.exc import IntegrityError


# ---------------------------------------------------------------------------
# Utilitaires génériques
# ---------------------------------------------------------------------------

def _filter_valid_columns(model_class, data, exclude=('id',)):
    """Ne garde que les clés correspondant à de vraies colonnes du modèle,
    en excluant systématiquement la clé primaire (jamais modifiable par payload)."""
    valid_keys = {c.name for c in model_class.__table__.columns} - set(exclude)
    return {k: v for k, v in data.items() if k in valid_keys}


# Modèles qui portent directement une colonne etablissement_id
DIRECT_SCOPE_MODELS = (Cycle, Classe, AnneeScolaire)


def get_etablissement_id_of(entity):
    """Retourne l'etablissement_id 'propriétaire' d'une entité,
    quelle que soit sa profondeur de rattachement."""
    if isinstance(entity, Sequence):
        return entity.trimestre.annee_scolaire.etablissement_id
    if isinstance(entity, Trimestre):
        return entity.annee_scolaire.etablissement_id
    return entity.etablissement_id  # Cycle, Classe, AnneeScolaire


def scoped_query(model_class, etablissement_id):
    """Construit une requête filtrée sur l'établissement, avec jointures
    pour les modèles qui n'ont pas de etablissement_id direct."""
    if model_class in DIRECT_SCOPE_MODELS:
        return model_class.query.filter_by(etablissement_id=etablissement_id)
    if model_class is Trimestre:
        return model_class.query.join(AnneeScolaire).filter(
            AnneeScolaire.etablissement_id == etablissement_id
        )
    if model_class is Sequence:
        return model_class.query.join(Trimestre).join(AnneeScolaire).filter(
            AnneeScolaire.etablissement_id == etablissement_id
        )
    raise ValueError(f"{model_class.__name__} n'est pas un modèle cloisonné par établissement")


def _validate_foreign_keys_scoped(model_class, data, etablissement_id):
    """Empêche un établissement de rattacher une entité à une clé étrangère
    (cycle, année scolaire, trimestre) appartenant à un AUTRE établissement.
    Retourne un message d'erreur ou None si tout est valide."""

    if model_class is Classe and 'cycle_id' in data:
        cycle = Cycle.query.get(data['cycle_id'])
        if not cycle or cycle.etablissement_id != etablissement_id:
            return "Cycle invalide pour cet établissement"

    if model_class is Trimestre and 'annee_scolaire_id' in data:
        annee = AnneeScolaire.query.get(data['annee_scolaire_id'])
        if not annee or annee.etablissement_id != etablissement_id:
            return "Année scolaire invalide pour cet établissement"

    if model_class is Sequence and 'trimestre_id' in data:
        trimestre = Trimestre.query.get(data['trimestre_id'])
        if not trimestre or trimestre.annee_scolaire.etablissement_id != etablissement_id:
            return "Trimestre invalide pour cet établissement"

    return None


# ---------------------------------------------------------------------------
# CRUD non cloisonné (réservé à l'administrateur -> Etablissement uniquement)
# ---------------------------------------------------------------------------

def create_entity(model_class, data):
    try:
        clean_data = _filter_valid_columns(model_class, data)
        entity = model_class(**clean_data)
        db.session.add(entity)
        db.session.commit()
        return entity.to_dict(), 201
    except IntegrityError:
        db.session.rollback()
        return {"erreur": "Violation de contrainte d'unicité"}, 409
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la création"}, 500


def get_all_entities(model_class):
    return [e.to_dict() for e in model_class.query.all()]


def get_entity_by_id(model_class, entity_id):
    return db.session.get(model_class, entity_id)


def update_entity(entity, data):
    try:
        clean_data = _filter_valid_columns(type(entity), data)
        for key, value in clean_data.items():
            setattr(entity, key, value)
        db.session.commit()
        return entity.to_dict(), 200
    except IntegrityError:
        db.session.rollback()
        return {"erreur": "Violation de contrainte d'unicité"}, 409
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la mise à jour"}, 500


def delete_entity(entity):
    try:
        db.session.delete(entity)
        db.session.commit()
        return {"message": "Supprimé avec succès"}, 200
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la suppression"}, 500


# ---------------------------------------------------------------------------
# CRUD cloisonné par établissement (Cycle, Classe, AnneeScolaire, Trimestre, Sequence)
# ---------------------------------------------------------------------------

def get_all_entities_scoped(model_class, etablissement_id):
    return [e.to_dict() for e in scoped_query(model_class, etablissement_id).all()]


def get_entity_scoped(model_class, entity_id, etablissement_id):
    """Renvoie None si l'entité n'existe pas OU n'appartient pas à l'établissement
    (on ne distingue pas les deux cas côté API, pour ne pas révéler l'existence
    de ressources d'un autre établissement)."""
    entity = db.session.get(model_class, entity_id)
    if not entity or get_etablissement_id_of(entity) != etablissement_id:
        return None
    return entity


def create_entity_scoped(model_class, data, etablissement_id):
    data = dict(data or {})

    # Le etablissement_id ne vient JAMAIS du payload client : toujours forcé
    # depuis le contexte JWT pour empêcher un établissement d'écrire chez un autre.
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