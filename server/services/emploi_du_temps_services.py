from models.emploi_du_temps_models import CreneauHoraire, Horaire, JOURS_SEMAINE
from models.pedagogie_models import MatiereClasse
from models.structure_models import Classe, AnneeScolaire
from extensions import db

# Les opérations CRUD "brutes" (create_entity, get_all_entities,
# get_entity_by_id, update_entity, delete_entity) sont 100% génériques :
# on les réutilise telles quelles comme brique de base des fonctions
# *_scoped ci-dessous, pour CreneauHoraire comme pour Horaire — même logique
# que pedagogie_services.py.
from services.structure_services import (
    create_entity, get_all_entities, get_entity_by_id, update_entity, delete_entity,
)


# ---------------------------------------------------------------------------
# Cloisonnement par établissement
#
# Les DEUX modèles de ce module sont cloisonnés par etablissement_id, mais
# selon deux logiques différentes :
#
# - CreneauHoraire porte directement la colonne etablissement_id (chaque
#   établissement gère sa propre grille de créneaux) : cloisonnement simple,
#   même logique que les référentiels pédagogiques (GroupeMatiere,
#   Departement, Grade, ... cf. pedagogie_models.py / pedagogie_services.py).
#
# - Horaire, lui, n'a pas de etablissement_id direct : son établissement
#   propriétaire se déduit avec DEUX sauts de jointure (contre un seul pour
#   TitulaireClasse/MatiereClasse dans pedagogie_services.py) :
#   matiere_classe_id -> MatiereClasse.classe_id -> Classe.etablissement_id.
# ---------------------------------------------------------------------------


# --- CreneauHoraire (cloisonnement direct) ---------------------------------

def get_all_creneaux_scoped(etablissement_id):
    return [c.to_dict() for c in
            CreneauHoraire.query.filter_by(etablissement_id=etablissement_id).all()]


def get_creneau_scoped(creneau_id, etablissement_id):
    """Renvoie None si le CreneauHoraire n'existe pas OU n'appartient pas à
    l'établissement (on ne distingue pas les deux cas côté API, pour ne pas
    révéler l'existence de ressources d'un autre établissement)."""
    entity = db.session.get(CreneauHoraire, creneau_id)
    if not entity or entity.etablissement_id != etablissement_id:
        return None
    return entity


def create_creneau_scoped(data, etablissement_id):
    data = dict(data or {})

    for champ in ('libelle', 'heure_debut', 'heure_fin'):
        if champ not in data:
            return {"erreur": f"{champ} requis"}, 400

    data['etablissement_id'] = etablissement_id
    return create_entity(CreneauHoraire, data)


def update_creneau_scoped(entity, data, etablissement_id):
    if entity.etablissement_id != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    data = dict(data or {})
    # etablissement_id n'est pas modifiable via l'API (déduit du contexte,
    # pas du payload) — même logique que pour les référentiels pédagogiques.
    data.pop('etablissement_id', None)

    return update_entity(entity, data)


def delete_creneau_scoped(entity, etablissement_id):
    if entity.etablissement_id != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    return delete_entity(entity)


# --- Horaire (cloisonnement indirect, via double jointure) -----------------


def get_etablissement_id_of(horaire):
    """Retourne l'etablissement_id 'propriétaire' d'un Horaire."""
    return horaire.matiere_classe.classe.etablissement_id


def scoped_query(etablissement_id, classe_ids_restriction=None):
    """Requête des Horaire filtrée sur l'établissement, via double jointure
    MatiereClasse -> Classe (Horaire n'a pas de etablissement_id direct).

    classe_ids_restriction : None pour Admin/SuperAdmin (pas de restriction
    supplémentaire, comportement inchangé) ; pour un Censeur/Surveillant, le
    set() des classe_id qui lui ont été assignées (cf.
    pedagogie_services.resolve_classe_ids_restriction) — potentiellement
    vide, auquel cas la requête ne renvoie aucun Horaire plutôt que tout
    l'établissement. Filtre sur MatiereClasse.classe_id, déjà joint
    ci-dessus."""
    query = (
        Horaire.query
        .join(MatiereClasse, Horaire.matiere_classe_id == MatiereClasse.id)
        .join(Classe, MatiereClasse.classe_id == Classe.id)
        .filter(Classe.etablissement_id == etablissement_id)
    )
    if classe_ids_restriction is not None:
        query = query.filter(MatiereClasse.classe_id.in_(classe_ids_restriction))
    return query


def _validate_foreign_keys_scoped(data, etablissement_id):
    """Empêche un établissement de programmer un horaire sur une
    MatiereClasse, une AnneeScolaire ou un CreneauHoraire appartenant à un
    AUTRE établissement, et valide la valeur 'libre' jour_semaine. Retourne
    un message d'erreur ou None si tout est valide."""

    if 'matiere_classe_id' in data:
        mc = MatiereClasse.query.get(data['matiere_classe_id'])
        if not mc or mc.classe.etablissement_id != etablissement_id:
            return "Matière-classe invalide pour cet établissement"

    if 'annee_scolaire_id' in data:
        annee = AnneeScolaire.query.get(data['annee_scolaire_id'])
        if not annee or annee.etablissement_id != etablissement_id:
            return "Année scolaire invalide pour cet établissement"

    if 'jour_semaine' in data and data['jour_semaine'] not in JOURS_SEMAINE:
        return "Jour de la semaine invalide"

    if 'creneau_id' in data:
        creneau = db.session.get(CreneauHoraire, data['creneau_id'])
        if not creneau or creneau.etablissement_id != etablissement_id:
            return "Créneau horaire invalide pour cet établissement"

    return None


def _check_collisions(data, exclude_horaire_id=None):
    """Détecte les collisions classe/enseignant (cours simultanés), NON
    couvertes par uq_horaire_matiere_classe_creneau qui ne bloque que la
    réaffectation de la MEME MatiereClasse. Deux MatiereClasse distinctes
    peuvent partager la même classe (matières différentes le même jour) ou
    le même enseignant (intervenant dans plusieurs classes) : on vérifie donc,
    pour le jour/créneau/année visés, qu'aucun autre Horaire n'occupe déjà la
    classe ou l'enseignant concernés — la jointure Horaire -> MatiereClasse
    annoncée sur le diagramme. Retourne un message d'erreur ou None."""

    mc = MatiereClasse.query.get(data['matiere_classe_id'])
    if not mc:
        return "Matière-classe invalide"

    query = (
        Horaire.query
        .join(MatiereClasse, Horaire.matiere_classe_id == MatiereClasse.id)
        .filter(
            Horaire.jour_semaine == data['jour_semaine'],
            Horaire.creneau_id == data['creneau_id'],
            Horaire.annee_scolaire_id == data['annee_scolaire_id'],
        )
    )
    if exclude_horaire_id:
        query = query.filter(Horaire.id != exclude_horaire_id)

    for autre in query.all():
        autre_mc = autre.matiere_classe
        if autre_mc.classe_id == mc.classe_id:
            return "Cette classe a déjà un cours sur ce créneau"
        if autre_mc.enseignant_id == mc.enseignant_id:
            return "Cet enseignant a déjà un cours sur ce créneau"

    return None


def get_all_entities_scoped(etablissement_id, classe_ids_restriction=None):
    return [h.to_dict() for h in scoped_query(etablissement_id, classe_ids_restriction).all()]


def get_entity_scoped(entity_id, etablissement_id, classe_ids_restriction=None):
    """Renvoie None si l'Horaire n'existe pas, n'appartient pas à
    l'établissement, OU (pour un Censeur/Surveillant) porte sur une classe
    hors de son périmètre assigné — on ne distingue pas ces cas côté API,
    pour ne pas révéler l'existence de ressources hors périmètre."""
    entity = db.session.get(Horaire, entity_id)
    if not entity or get_etablissement_id_of(entity) != etablissement_id:
        return None
    if (classe_ids_restriction is not None
            and entity.matiere_classe.classe_id not in classe_ids_restriction):
        return None
    return entity


def create_entity_scoped(data, etablissement_id, classe_ids_restriction=None):
    data = dict(data or {})

    for champ in ('matiere_classe_id', 'annee_scolaire_id', 'jour_semaine', 'creneau_id'):
        if champ not in data:
            return {"erreur": f"{champ} requis"}, 400

    error = _validate_foreign_keys_scoped(data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    if classe_ids_restriction is not None:
        # Empêche un Censeur/Surveillant de programmer un cours sur une
        # MatiereClasse rattachée à une classe qui ne lui a pas été
        # assignée (cf. CenseurClasse/SurveillantClasse).
        mc = MatiereClasse.query.get(data['matiere_classe_id'])
        if not mc or mc.classe_id not in classe_ids_restriction:
            return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    error = _check_collisions(data)
    if error:
        return {"erreur": error}, 409

    return create_entity(Horaire, data)


def update_entity_scoped(entity, data, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    if (classe_ids_restriction is not None
            and entity.matiere_classe.classe_id not in classe_ids_restriction):
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    data = dict(data or {})

    error = _validate_foreign_keys_scoped(data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    # PUT potentiellement partiel : on fusionne avec les valeurs actuelles
    # de l'entité pour vérifier les collisions sur l'état final, pas
    # seulement sur les champs fournis dans le payload.
    merged = {
        'matiere_classe_id': data.get('matiere_classe_id', entity.matiere_classe_id),
        'jour_semaine': data.get('jour_semaine', entity.jour_semaine),
        'creneau_id': data.get('creneau_id', entity.creneau_id),
        'annee_scolaire_id': data.get('annee_scolaire_id', entity.annee_scolaire_id),
    }

    if classe_ids_restriction is not None and 'matiere_classe_id' in data:
        # Empêche également de DÉPLACER le cours vers une MatiereClasse
        # d'une classe hors périmètre.
        nouvelle_mc = MatiereClasse.query.get(merged['matiere_classe_id'])
        if not nouvelle_mc or nouvelle_mc.classe_id not in classe_ids_restriction:
            return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    error = _check_collisions(merged, exclude_horaire_id=entity.id)
    if error:
        return {"erreur": error}, 409

    return update_entity(entity, data)


def delete_entity_scoped(entity, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    if (classe_ids_restriction is not None
            and entity.matiere_classe.classe_id not in classe_ids_restriction):
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403
    return delete_entity(entity)