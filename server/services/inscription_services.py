import os
import uuid

from models.inscription_models import Parent, Eleve, Inscription, STATUTS_INSCRIPTION
from models.structure_models import Classe, AnneeScolaire
from extensions import db

# Les opérations CRUD "brutes" (create_entity, get_all_entities,
# get_entity_by_id, update_entity, delete_entity) sont 100% génériques : on
# les réutilise telles quelles comme brique de base des fonctions *_scoped
# ci-dessous — même logique que pedagogie_services.py et
# emploi_du_temps_services.py.
from services.structure_services import (
    create_entity, get_all_entities, get_entity_by_id, update_entity, delete_entity,
    STORAGE_DIR,
)
from services.conflits_services import extraire_controle, memes_valeurs, verifier


# ---------------------------------------------------------------------------
# Photos d'identité des élèves
#
# Stockées dans storage/photos_eleves/<etablissement_id>/ (même volume Docker
# persistant que les logos, cf. docker-compose.prod.yml : server-storage),
# sous un nom ALÉATOIRE (uuid), jamais dérivé de l'identité de l'élève.
# Servies uniquement par des routes protégées par JWT et cloisonnées
# (inscription_api : secrétariat/admin ; bulletin_api : rôles du bulletin).
#
# Formats : JPEG, PNG, WEBP (pas de SVG, qui peut embarquer du script),
# vérifiés sur la SIGNATURE binaire du fichier et non sur son extension.
# ---------------------------------------------------------------------------

PHOTOS_ELEVES_DIR = os.path.join(STORAGE_DIR, 'photos_eleves')
os.makedirs(PHOTOS_ELEVES_DIR, exist_ok=True)

PHOTO_TAILLE_MAX = 2 * 1024 * 1024  # 2 Mo


def _format_image(entete):
    if entete.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if entete.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if entete[:4] == b'RIFF' and entete[8:12] == b'WEBP':
        return 'webp'
    return None


def photos_dir_of(etablissement_id):
    return os.path.join(PHOTOS_ELEVES_DIR, str(int(etablissement_id)))


def chemin_photo_eleve(eleve):
    """Chemin absolu du fichier photo de l'élève, ou None s'il n'en a pas
    (ou si le fichier a disparu du disque)."""
    if not eleve or not eleve.photo:
        return None
    chemin = os.path.join(photos_dir_of(eleve.etablissement_id), os.path.basename(eleve.photo))
    return chemin if os.path.isfile(chemin) else None


def delete_photo_file(etablissement_id, filename):
    """Best-effort, ne lève jamais (même logique que delete_logo_file)."""
    if not filename:
        return
    chemin = os.path.join(photos_dir_of(etablissement_id), os.path.basename(filename))
    if os.path.isfile(chemin):
        try:
            os.remove(chemin)
        except OSError:
            pass


def save_photo_eleve(eleve, file_storage):
    """Enregistre la photo uploadée (werkzeug FileStorage), remplace
    l'éventuelle ancienne et met à jour Eleve.photo."""
    if not file_storage or not getattr(file_storage, 'filename', None):
        return {"erreur": "Aucun fichier photo reçu"}, 400

    contenu = file_storage.read(PHOTO_TAILLE_MAX + 1)
    if len(contenu) > PHOTO_TAILLE_MAX:
        return {"erreur": "Photo trop volumineuse (2 Mo maximum)"}, 400
    ext = _format_image(contenu[:16])
    if not ext:
        return {"erreur": "Format de photo non pris en charge (JPEG, PNG ou WEBP uniquement)"}, 400

    dossier = photos_dir_of(eleve.etablissement_id)
    os.makedirs(dossier, exist_ok=True)
    filename = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(dossier, filename), 'wb') as f:
        f.write(contenu)

    ancienne = eleve.photo
    eleve.photo = filename
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        delete_photo_file(eleve.etablissement_id, filename)
        return {"erreur": "Impossible d'enregistrer la photo"}, 500

    # Ancien fichier supprimé seulement APRÈS le commit réussi : un élève ne
    # pointe jamais vers un fichier disparu.
    if ancienne and ancienne != filename:
        delete_photo_file(eleve.etablissement_id, ancienne)
    return eleve.to_dict(), 200


def delete_photo_eleve(eleve):
    ancienne = eleve.photo
    if not ancienne:
        return eleve.to_dict(), 200
    eleve.photo = None
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return {"erreur": "Impossible de retirer la photo"}, 500
    delete_photo_file(eleve.etablissement_id, ancienne)
    return eleve.to_dict(), 200

CHAMPS_REQUIS = {
    Parent: ('nom', 'prenom', 'telephone', 'email'),
    Eleve: ('matricule', 'nom', 'prenom', 'sexe', 'lieu_naissance', 'parent_id'),
    Inscription: ('eleve_id', 'classe_id', 'annee_scolaire_id', 'date_inscription'),
}
LIBELLES = {Parent: 'parent', Eleve: 'élève', Inscription: 'inscription'}


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

    if model_class is Inscription and data.get('statut') not in (None, '') \
            and data['statut'] not in STATUTS_INSCRIPTION:
        return f"Statut d'inscription invalide (attendu : {', '.join(STATUTS_INSCRIPTION)})"

    return None


def _valider_inscription_unique(eleve_id, annee_scolaire_id, inscription_id=None):
    """Un élève n'a qu'une inscription par année scolaire, toutes classes
    confondues : la contrainte uq_inscription (élève, classe, année)
    laissait inscrire le même élève dans deux classes la même année, ce qui
    dédoublait ses notes, son rang et son échéancier de paiement. Retourne
    un message d'erreur ou None."""
    query = Inscription.query.filter(Inscription.eleve_id == eleve_id,
                                     Inscription.annee_scolaire_id == annee_scolaire_id)
    if inscription_id is not None:
        query = query.filter(Inscription.id != inscription_id)
    if query.first():
        return ("Cet élève est déjà inscrit pour cette année scolaire : modifiez son "
                "inscription existante pour changer de classe")
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
    data.pop('photo', None)  # uniquement via save_photo_eleve (upload)

    for champ in CHAMPS_REQUIS.get(model_class, ()):
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
        if str(data.get('classe_id')) not in {str(c) for c in classe_ids_restriction}:
            return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    if model_class is Inscription:
        error = _valider_inscription_unique(data['eleve_id'], data['annee_scolaire_id'])
        if error:
            return {"erreur": error}, 409

    return create_entity(model_class, data)


def update_entity_scoped(entity, data, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    data = dict(data or {})
    data.pop('etablissement_id', None)  # non modifiable, même par erreur de payload
    data.pop('photo', None)  # uniquement via save_photo_eleve / delete_photo_eleve
    controle = extraire_controle(data)

    if isinstance(entity, Inscription) and classe_ids_restriction is not None:
        # L'entité existante est déjà dans le périmètre (garanti par
        # get_entity_scoped, appelé en amont côté API) ; on vérifie ICI en
        # plus la classe CIBLE, si le payload cherche à déplacer
        # l'inscription vers une autre classe hors périmètre.
        nouveau_classe_id = data.get('classe_id', entity.classe_id)
        if str(nouveau_classe_id) not in {str(c) for c in classe_ids_restriction}:
            return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    error = _validate_foreign_keys_scoped(type(entity), data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    if isinstance(entity, Inscription) and ('eleve_id' in data or 'annee_scolaire_id' in data):
        error = _valider_inscription_unique(data.get('eleve_id', entity.eleve_id),
                                            data.get('annee_scolaire_id', entity.annee_scolaire_id),
                                            entity.id)
        if error:
            return {"erreur": error}, 409

    # Modification concurrente (saisie hors connexion, autre poste) : 409,
    # l'utilisateur tranche (cf. conflits_services).
    valeurs = {k: v for k, v in data.items() if k in type(entity).__table__.columns and k not in ('id', 'version')}
    conflit = verifier(entity, controle, valeurs,
                       message_conflit=f"Cette fiche ({LIBELLES[type(entity)]}) a été modifiée par quelqu'un "
                                       "d'autre depuis votre saisie.")
    if conflit:
        return conflit
    if valeurs and memes_valeurs(entity, valeurs):
        return entity.to_dict(), 200

    return update_entity(entity, data)


def delete_entity_scoped(entity, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    if (isinstance(entity, Inscription) and classe_ids_restriction is not None
            and entity.classe_id not in classe_ids_restriction):
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403
    photo = entity.photo if isinstance(entity, Eleve) else None
    result, status = delete_entity(entity)
    # Fichier retiré seulement si la suppression en base a réussi.
    if photo and status < 300:
        delete_photo_file(etablissement_id, photo)
    return result, status