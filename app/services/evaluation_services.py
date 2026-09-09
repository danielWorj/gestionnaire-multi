from datetime import datetime

from models.evaluation_models import Note, Discipline
from models.pedagogie_models import MatiereClasse
from models.inscription_models import Inscription
from models.structure_models import Classe, Sequence
from extensions import db

# Les opérations CRUD "brutes" (create_entity, get_all_entities,
# get_entity_by_id, update_entity, delete_entity) sont 100% génériques : on
# les réutilise telles quelles comme brique de base des fonctions *_scoped
# ci-dessous — même logique que pedagogie_services.py,
# emploi_du_temps_services.py et inscription_services.py.
from services.structure_services import (
    create_entity, get_all_entities, get_entity_by_id, update_entity, delete_entity,
)


# ---------------------------------------------------------------------------
# Cloisonnement par établissement
#
# Ni Note ni Discipline ne portent de colonne etablissement_id directe (cf.
# docstring de evaluation_models.py) :
#   - Discipline : UN saut -> inscription_id -> Inscription.classe_id ->
#     Classe.etablissement_id
#   - Note : DEUX chemins devant rester cohérents entre eux (même classe
#     des deux côtés) -> inscription_id -> Inscription.classe_id, et
#     matiere_classe_id -> MatiereClasse.classe_id
# ---------------------------------------------------------------------------


def get_etablissement_id_of_note(note):
    """Retourne l'etablissement_id 'propriétaire' d'une Note, déduit via sa
    MatiereClasse (les deux chemins possibles convergent toujours vers le
    même établissement pour une Note valide, cf. _validate_note_coherence)."""
    return note.matiere_classe.classe.etablissement_id


def get_etablissement_id_of_discipline(discipline):
    return discipline.inscription.classe.etablissement_id


# ===========================================================================
# NOTE
#
# Écriture (création/modification/suppression) réservée au SEUL Enseignant,
# et uniquement sur les MatiereClasse qui lui ont été attribuées par l'Admin
# — jamais à l'Admin, au SuperAdmin, au Censeur ni au Surveillant, qui
# restent strictement en lecture (cf. evaluation_api.note_bp).
# ===========================================================================

def resolve_enseignant_matiere_classe_ids(enseignant_id):
    """Ensemble des matiere_classe_id attribuées à un Enseignant donné —
    c'est ce qui délimite tout son périmètre sur ce module : il ne peut
    lire/écrire de Note QUE sur ces MatiereClasse, jamais sur celles d'un
    collègue. Retourne un set() vide (jamais None) si enseignant_id est
    None/absent (profil pas encore relié à un compte de connexion) ou si
    aucune matière ne lui a été attribuée — par prudence, on restreint
    systématiquement plutôt que d'ouvrir tout l'établissement par défaut."""
    if not enseignant_id:
        return set()
    return {mc.id for mc in MatiereClasse.query.filter_by(enseignant_id=enseignant_id).all()}


def _note_query(etablissement_id, classe_ids_restriction=None, matiere_classe_ids_restriction=None):
    """Requête des Note filtrée sur l'établissement, via jointure
    MatiereClasse -> Classe (Note n'a pas de etablissement_id direct).

    classe_ids_restriction : set() de classe_id pour un Censeur/Surveillant
    en LECTURE SEULE (cf. pedagogie_services.resolve_classe_ids_restriction)
    — None pour Admin/SuperAdmin.

    matiere_classe_ids_restriction : set() de matiere_classe_id pour un
    Enseignant, restreint à SES PROPRES matières-classe (cf.
    resolve_enseignant_matiere_classe_ids ci-dessus) — None pour tout autre
    rôle. Mutuellement exclusif avec classe_ids_restriction en pratique (un
    seul rôle à la fois consulte ce endpoint)."""
    query = (
        Note.query
        .join(MatiereClasse, Note.matiere_classe_id == MatiereClasse.id)
        .join(Classe, MatiereClasse.classe_id == Classe.id)
        .filter(Classe.etablissement_id == etablissement_id)
    )
    if classe_ids_restriction is not None:
        query = query.filter(MatiereClasse.classe_id.in_(classe_ids_restriction))
    if matiere_classe_ids_restriction is not None:
        query = query.filter(Note.matiere_classe_id.in_(matiere_classe_ids_restriction))
    return query


def _validate_note_coherence(data, etablissement_id):
    """Vérifie que inscription_id et matiere_classe_id appartiennent bien à
    l'établissement courant ET portent sur LA MÊME classe (une note n'a de
    sens que si l'élève inscrit et la matière-classe notée sont dans la même
    classe) ; vérifie également que sequence_id appartient à l'établissement
    (via Sequence -> Trimestre -> AnneeScolaire, comme dans
    structure_services._validate_foreign_keys_scoped). Retourne un message
    d'erreur ou None si tout est valide."""
    mc = None
    inscription = None

    if 'matiere_classe_id' in data:
        mc = MatiereClasse.query.get(data['matiere_classe_id'])
        if not mc or mc.classe.etablissement_id != etablissement_id:
            return "Matière-classe invalide pour cet établissement"

    if 'inscription_id' in data:
        inscription = Inscription.query.get(data['inscription_id'])
        if not inscription or inscription.classe.etablissement_id != etablissement_id:
            return "Inscription invalide pour cet établissement"

    if mc and inscription and mc.classe_id != inscription.classe_id:
        return "L'élève inscrit et la matière-classe ne portent pas sur la même classe"

    if 'sequence_id' in data:
        sequence = db.session.get(Sequence, data['sequence_id'])
        if not sequence or sequence.trimestre.annee_scolaire.etablissement_id != etablissement_id:
            return "Séquence invalide pour cet établissement"

    return None


def _validate_valeur(data):
    """valeur est optionnelle (élève absent), mais si fournie et non-nulle,
    doit être un nombre dans [0, 20] — même borne que ck_note_valeur en base,
    vérifiée ici en amont pour renvoyer un message clair plutôt qu'une
    IntegrityError brute."""
    if 'valeur' not in data or data['valeur'] is None:
        return None
    try:
        valeur = float(data['valeur'])
    except (TypeError, ValueError):
        return "Valeur invalide"
    if not (0 <= valeur <= 20):
        return "La valeur doit être comprise entre 0 et 20"
    return None


def get_all_notes_scoped(etablissement_id, classe_ids_restriction=None, matiere_classe_ids_restriction=None):
    return [n.to_dict() for n in
            _note_query(etablissement_id, classe_ids_restriction, matiere_classe_ids_restriction).all()]


def get_note_scoped(note_id, etablissement_id, classe_ids_restriction=None, matiere_classe_ids_restriction=None):
    """Renvoie None si la Note n'existe pas, n'appartient pas à
    l'établissement, OU est hors du périmètre autorisé (classe assignée pour
    un Censeur/Surveillant, matière-classe propre pour un Enseignant) — sans
    distinguer ces cas côté API, pour ne pas révéler l'existence de
    ressources hors périmètre."""
    entity = db.session.get(Note, note_id)
    if not entity or get_etablissement_id_of_note(entity) != etablissement_id:
        return None
    if classe_ids_restriction is not None and entity.matiere_classe.classe_id not in classe_ids_restriction:
        return None
    if matiere_classe_ids_restriction is not None and entity.matiere_classe_id not in matiere_classe_ids_restriction:
        return None
    return entity


def create_note_scoped(data, etablissement_id, matiere_classe_ids_restriction):
    """Réservé au SEUL Enseignant (cf. evaluation_api.py) : contrairement à
    get_note_scoped ci-dessus, matiere_classe_ids_restriction n'est donc
    jamais None ici — un Enseignant sans profil relié ou sans matière
    attribuée reçoit un set() vide, ce qui bloque toute création plutôt que
    de l'ouvrir par erreur."""
    data = dict(data or {})

    for champ in ('inscription_id', 'matiere_classe_id', 'sequence_id'):
        if data.get(champ) in (None, ''):
            return {"erreur": f"{champ} requis"}, 400

    error = _validate_note_coherence(data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    if int(data['matiere_classe_id']) not in matiere_classe_ids_restriction:
        return {"erreur": "Matière non attribuée : vous n'avez pas la charge de cette matière-classe"}, 403

    error = _validate_valeur(data)
    if error:
        return {"erreur": error}, 400

    return create_entity(Note, data)


def update_note_scoped(entity, data, etablissement_id, matiere_classe_ids_restriction):
    if get_etablissement_id_of_note(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403

    if entity.matiere_classe_id not in matiere_classe_ids_restriction:
        return {"erreur": "Matière non attribuée : vous n'avez pas la charge de cette matière-classe"}, 403

    data = dict(data or {})

    # PUT potentiellement partiel : on fusionne avec les valeurs actuelles de
    # l'entité pour revalider l'état final, pas seulement les champs fournis
    # dans le payload — matiere_classe_id/inscription_id/sequence_id ne sont
    # normalement pas modifiés après coup (une correction se fait sur
    # 'valeur'/'absent'), mais on les revalide quand même par cohérence
    # défensive avec le reste de l'application.
    merged = {
        'matiere_classe_id': data.get('matiere_classe_id', entity.matiere_classe_id),
        'inscription_id': data.get('inscription_id', entity.inscription_id),
        'sequence_id': data.get('sequence_id', entity.sequence_id),
    }
    error = _validate_note_coherence(merged, etablissement_id)
    if error:
        return {"erreur": error}, 400

    if 'matiere_classe_id' in data and int(data['matiere_classe_id']) not in matiere_classe_ids_restriction:
        # Empêche également de DÉPLACER la note vers une MatiereClasse hors
        # périmètre (même logique que emploi_du_temps_services.update_entity_scoped).
        return {"erreur": "Matière non attribuée : vous n'avez pas la charge de cette matière-classe"}, 403

    error = _validate_valeur(data)
    if error:
        return {"erreur": error}, 400

    # Une correction se fait sur la ligne existante (uq_note) : on rafraîchit
    # saisie_le à chaque modification pour tracer la dernière écriture.
    data['saisie_le'] = datetime.utcnow()

    return update_entity(entity, data)


def delete_note_scoped(entity, etablissement_id, matiere_classe_ids_restriction):
    if get_etablissement_id_of_note(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    if entity.matiere_classe_id not in matiere_classe_ids_restriction:
        return {"erreur": "Matière non attribuée : vous n'avez pas la charge de cette matière-classe"}, 403
    return delete_entity(entity)


# ===========================================================================
# DISCIPLINE
#
# Lecture ET écriture réservées à Censeur/Surveillant (+ Admin/SuperAdmin) —
# l'Enseignant n'a ici AUCUN accès (cf. evaluation_api.discipline_bp).
# Censeur/Surveillant restreints (sur TOUS les verbes, pas seulement GET) aux
# classes qui leur ont été assignées.
# ===========================================================================

def _discipline_query(etablissement_id, classe_ids_restriction=None):
    query = (
        Discipline.query
        .join(Inscription, Discipline.inscription_id == Inscription.id)
        .join(Classe, Inscription.classe_id == Classe.id)
        .filter(Classe.etablissement_id == etablissement_id)
    )
    if classe_ids_restriction is not None:
        query = query.filter(Inscription.classe_id.in_(classe_ids_restriction))
    return query


def _validate_discipline_foreign_keys(data, etablissement_id):
    if 'inscription_id' in data:
        inscription = Inscription.query.get(data['inscription_id'])
        if not inscription or inscription.classe.etablissement_id != etablissement_id:
            return "Inscription invalide pour cet établissement"

    if 'sequence_id' in data:
        sequence = db.session.get(Sequence, data['sequence_id'])
        if not sequence or sequence.trimestre.annee_scolaire.etablissement_id != etablissement_id:
            return "Séquence invalide pour cet établissement"

    return None


def _validate_compteurs_discipline(data):
    """absences_justifiees / absences_non_justifiees / retards / exclusions
    doivent être des entiers positifs ou nuls (même borne que les
    CheckConstraint en base), vérifié ici pour un message d'erreur clair."""
    for champ in ('absences_justifiees', 'absences_non_justifiees', 'retards', 'exclusions'):
        if champ in data and data[champ] is not None:
            try:
                valeur = int(data[champ])
            except (TypeError, ValueError):
                return f"{champ} invalide"
            if valeur < 0:
                return f"{champ} doit être un entier positif ou nul"
    return None


def get_all_disciplines_scoped(etablissement_id, classe_ids_restriction=None):
    return [d.to_dict() for d in _discipline_query(etablissement_id, classe_ids_restriction).all()]


def get_discipline_scoped(discipline_id, etablissement_id, classe_ids_restriction=None):
    """Renvoie None si la fiche n'existe pas, n'appartient pas à
    l'établissement, OU (pour un Censeur/Surveillant) porte sur une classe
    hors de son périmètre assigné — sans distinguer ces cas côté API."""
    entity = db.session.get(Discipline, discipline_id)
    if not entity or get_etablissement_id_of_discipline(entity) != etablissement_id:
        return None
    if classe_ids_restriction is not None and entity.inscription.classe_id not in classe_ids_restriction:
        return None
    return entity


def create_discipline_scoped(data, etablissement_id, classe_ids_restriction=None):
    data = dict(data or {})

    for champ in ('inscription_id', 'sequence_id'):
        if data.get(champ) in (None, ''):
            return {"erreur": f"{champ} requis"}, 400

    error = _validate_discipline_foreign_keys(data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    if classe_ids_restriction is not None:
        # Empêche un Censeur/Surveillant de saisir une fiche disciplinaire
        # sur une classe qui ne lui a pas été assignée.
        inscription = Inscription.query.get(data['inscription_id'])
        if not inscription or inscription.classe_id not in classe_ids_restriction:
            return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    error = _validate_compteurs_discipline(data)
    if error:
        return {"erreur": error}, 400

    return create_entity(Discipline, data)


def update_discipline_scoped(entity, data, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of_discipline(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    if classe_ids_restriction is not None and entity.inscription.classe_id not in classe_ids_restriction:
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    data = dict(data or {})

    if 'inscription_id' in data and classe_ids_restriction is not None:
        # Empêche également de DÉPLACER la fiche vers une Inscription d'une
        # classe hors périmètre.
        inscription = Inscription.query.get(data['inscription_id'])
        if not inscription or inscription.classe_id not in classe_ids_restriction:
            return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403

    error = _validate_discipline_foreign_keys(data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    error = _validate_compteurs_discipline(data)
    if error:
        return {"erreur": error}, 400

    return update_entity(entity, data)


def delete_discipline_scoped(entity, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of_discipline(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    if classe_ids_restriction is not None and entity.inscription.classe_id not in classe_ids_restriction:
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403
    return delete_entity(entity)