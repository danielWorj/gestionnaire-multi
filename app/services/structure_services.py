import os
import re
import unicodedata
from werkzeug.utils import secure_filename

from models.structure_models import (
    Etablissement, Cycle, Classe, AnneeScolaire, Trimestre, Sequence
)
from extensions import db
from sqlalchemy.exc import IntegrityError


# ---------------------------------------------------------------------------
# Stockage des logos d'établissement
# ---------------------------------------------------------------------------
# Dossier "storage/" à la RACINE du projet. Ce fichier vit dans
# <racine_projet>/services/structure_services.py, donc la racine du projet
# est le dossier parent de "services/".
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORAGE_DIR = os.path.join(BASE_DIR, 'storage')
LOGOS_DIR = os.path.join(STORAGE_DIR, 'logos')
os.makedirs(LOGOS_DIR, exist_ok=True)

ALLOWED_LOGO_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'}


def _slugify(value):
    """Transforme un nom d'établissement en un identifiant de fichier sûr :
    sans accents, sans espaces, sans caractères spéciaux (ex: 'Lycée de
    Yaoundé' -> 'lycee-de-yaounde')."""
    value = unicodedata.normalize('NFKD', value or '').encode('ascii', 'ignore').decode('ascii')
    value = re.sub(r'[^\w\s-]', '', value).strip().lower()
    value = re.sub(r'[-\s]+', '-', value)
    return value or 'etablissement'


def _extension_autorisee(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_LOGO_EXTENSIONS


def delete_logo_file(filename):
    """Supprime un fichier logo du disque s'il existe. Ne lève jamais
    d'exception (best-effort) pour ne pas casser une opération CRUD sur
    un simple problème de suppression de fichier."""
    if not filename:
        return
    filepath = os.path.join(LOGOS_DIR, filename)
    if os.path.isfile(filepath):
        try:
            os.remove(filepath)
        except OSError:
            pass


def save_logo_file(file_storage, nom_etablissement, ancien_logo=None):
    """Enregistre le fichier logo uploadé (werkzeug FileStorage) dans
    storage/logos/, en le renommant d'après le nom de l'établissement
    (slug + extension d'origine). Retourne le nom de fichier à stocker
    tel quel dans le champ `logo` de l'établissement.

    Si un ancien logo existait sous un nom différent (ex: extension
    différente lors d'un remplacement), il est supprimé pour ne pas
    laisser de fichier orphelin sur le disque."""
    if not file_storage or not getattr(file_storage, 'filename', None):
        return None

    original_name = secure_filename(file_storage.filename)
    if not _extension_autorisee(original_name):
        raise ValueError(
            "Extension de fichier non autorisée pour le logo "
            f"(autorisées : {', '.join(sorted(ALLOWED_LOGO_EXTENSIONS))})"
        )

    ext = original_name.rsplit('.', 1)[1].lower()
    filename = f"{_slugify(nom_etablissement)}.{ext}"

    if ancien_logo and ancien_logo != filename:
        delete_logo_file(ancien_logo)

    file_storage.save(os.path.join(LOGOS_DIR, filename))
    return filename


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


def scoped_query(model_class, etablissement_id, classe_ids_restriction=None):
    """Construit une requête filtrée sur l'établissement, avec jointures
    pour les modèles qui n'ont pas de etablissement_id direct.

    classe_ids_restriction : UNIQUEMENT pertinent pour model_class is Classe
    (cf. pedagogie_services.resolve_classe_ids_restriction) — None pour
    Admin/SuperAdmin (pas de restriction, comportement inchangé) ; pour un
    Censeur/Surveillant, restreint la liste à ses classes assignées
    (potentiellement aucune). Sans effet pour Cycle/AnneeScolaire/Trimestre/
    Sequence, qui restent des référentiels établissement-larges pour tous
    les rôles qui y ont accès (cf. structure_api.py)."""
    if model_class in DIRECT_SCOPE_MODELS:
        query = model_class.query.filter_by(etablissement_id=etablissement_id)
        if model_class is Classe and classe_ids_restriction is not None:
            query = query.filter(Classe.id.in_(classe_ids_restriction))
        return query
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
        logo_a_supprimer = entity.logo if isinstance(entity, Etablissement) else None
        db.session.delete(entity)
        db.session.commit()
        # Le fichier n'est retiré du disque qu'APRÈS le commit réussi en base,
        # pour ne jamais perdre un logo si la suppression échoue.
        if logo_a_supprimer:
            delete_logo_file(logo_a_supprimer)
        return {"message": "Supprimé avec succès"}, 200
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la suppression"}, 500


# ---------------------------------------------------------------------------
# CRUD Etablissement avec upload de logo
# ---------------------------------------------------------------------------
# Le champ `logo` n'est JAMAIS renseigné directement depuis le payload client
# (on ignore une éventuelle valeur texte envoyée dans le formulaire) : il est
# toujours dérivé du fichier uploadé, pour empêcher qu'on y injecte un chemin
# ou une URL arbitraire.

def create_etablissement(data, logo_file=None):
    data = dict(data or {})
    data.pop('logo', None)
    try:
        if logo_file and getattr(logo_file, 'filename', None):
            data['logo'] = save_logo_file(logo_file, data.get('nom', ''))
        return create_entity(Etablissement, data)
    except ValueError as e:
        return {"erreur": str(e)}, 400


def update_etablissement(entity, data, logo_file=None):
    data = dict(data or {})
    data.pop('logo', None)
    try:
        if logo_file and getattr(logo_file, 'filename', None):
            nom_pour_fichier = data.get('nom') or entity.nom
            data['logo'] = save_logo_file(logo_file, nom_pour_fichier, ancien_logo=entity.logo)
        elif data.get('nom') and data.get('nom') != entity.nom and entity.logo:
            # Le nom change et un logo existe déjà sans nouveau fichier fourni :
            # on renomme le fichier existant pour qu'il reste cohérent avec le
            # nouveau nom de l'établissement.
            ext = entity.logo.rsplit('.', 1)[-1] if '.' in entity.logo else None
            if ext:
                nouveau_nom = f"{_slugify(data['nom'])}.{ext}"
                ancien_path = os.path.join(LOGOS_DIR, entity.logo)
                if nouveau_nom != entity.logo and os.path.isfile(ancien_path):
                    os.replace(ancien_path, os.path.join(LOGOS_DIR, nouveau_nom))
                data['logo'] = nouveau_nom
        return update_entity(entity, data)
    except ValueError as e:
        return {"erreur": str(e)}, 400


# ---------------------------------------------------------------------------
# CRUD cloisonné par établissement (Cycle, Classe, AnneeScolaire, Trimestre, Sequence)
# ---------------------------------------------------------------------------

def get_all_entities_scoped(model_class, etablissement_id, classe_ids_restriction=None):
    return [e.to_dict() for e in scoped_query(model_class, etablissement_id, classe_ids_restriction).all()]


def get_entity_scoped(model_class, entity_id, etablissement_id, classe_ids_restriction=None):
    """Renvoie None si l'entité n'existe pas, n'appartient pas à l'établissement,
    OU (pour une Classe consultée par un Censeur/Surveillant) n'est pas dans
    son périmètre assigné (on ne distingue pas ces cas côté API, pour ne pas
    révéler l'existence de ressources hors périmètre)."""
    entity = db.session.get(model_class, entity_id)
    if not entity or get_etablissement_id_of(entity) != etablissement_id:
        return None
    if model_class is Classe and classe_ids_restriction is not None and entity.id not in classe_ids_restriction:
        return None
    return entity


def create_entity_scoped(model_class, data, etablissement_id):
    # NB : pas de classe_ids_restriction ici — pour Classe, la création est
    # réservée à Admin/SuperAdmin (cf. structure_api.classe_bp,
    # create_roles_autorises) : une classe n'existe pas encore au moment où
    # on la crée, elle ne peut donc jamais être "dans le périmètre assigné"
    # d'un Censeur/Surveillant. Les autres modèles cloisonnés (Cycle,
    # AnneeScolaire, Trimestre, Sequence) ne sont de toute façon pas
    # restreints par classe (cf. scoped_query).
    data = dict(data or {})

    # Le etablissement_id ne vient JAMAIS du payload client : toujours forcé
    # depuis le contexte JWT pour empêcher un établissement d'écrire chez un autre.
    if model_class in DIRECT_SCOPE_MODELS:
        data['etablissement_id'] = etablissement_id

    error = _validate_foreign_keys_scoped(model_class, data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    return create_entity(model_class, data)


def update_entity_scoped(entity, data, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    if (isinstance(entity, Classe) and classe_ids_restriction is not None
            and entity.id not in classe_ids_restriction):
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    data = dict(data or {})
    data.pop('etablissement_id', None)  # non modifiable, même par erreur de payload

    error = _validate_foreign_keys_scoped(type(entity), data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    return update_entity(entity, data)


def delete_entity_scoped(entity, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    if (isinstance(entity, Classe) and classe_ids_restriction is not None
            and entity.id not in classe_ids_restriction):
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403
    return delete_entity(entity)