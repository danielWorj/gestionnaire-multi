import os
import re
import secrets
import unicodedata
from werkzeug.utils import secure_filename
from flask import current_app

from models.structure_models import (
    Etablissement, Cycle, Classe, AnneeScolaire, Trimestre, Sequence, Niveau, effectifs_classes
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


def save_logo_file(file_storage, nom_etablissement):
    """Enregistre le fichier logo uploadé (werkzeug FileStorage) dans
    storage/logos/ sous un nom UNIQUE (slug du nom + suffixe aléatoire +
    extension d'origine) : deux établissements de même nom ne peuvent plus
    écraser (ni supprimer) le logo l'un de l'autre. Retourne le nom de
    fichier à stocker dans le champ `logo` de l'établissement ; l'appelant
    supprime l'ancien logo une fois la base à jour."""
    if not file_storage or not getattr(file_storage, 'filename', None):
        return None

    original_name = secure_filename(file_storage.filename)
    if not _extension_autorisee(original_name):
        raise ValueError(
            "Extension de fichier non autorisée pour le logo "
            f"(autorisées : {', '.join(sorted(ALLOWED_LOGO_EXTENSIONS))})"
        )

    ext = original_name.rsplit('.', 1)[1].lower()
    filename = f"{_slugify(nom_etablissement)[:60]}-{secrets.token_hex(4)}.{ext}"

    file_storage.save(os.path.join(LOGOS_DIR, filename))
    return filename


# ---------------------------------------------------------------------------
# Utilitaires génériques
# ---------------------------------------------------------------------------

def _filter_valid_columns(model_class, data, exclude=('id', 'version')):
    """Ne garde que les clés correspondant à de vraies colonnes du modèle,
    en excluant systématiquement la clé primaire et `version` (tenue par le
    serveur, cf. audit_services : jamais modifiable par payload)."""
    colonnes = model_class.__table__.columns
    valid_keys = {c.name for c in colonnes} - set(exclude)
    clean = {k: v for k, v in data.items() if k in valid_keys}
    # Email facultatif (Enseignant, Censeur, Surveillant) laissé vide : NULL
    # et non '', sinon la contrainte UNIQUE refuserait un second email vide.
    if 'email' in clean and 'email' in colonnes and colonnes['email'].nullable             and not (clean['email'] or '').strip():
        clean['email'] = None
    return clean


# Modèles qui portent directement une colonne etablissement_id
DIRECT_SCOPE_MODELS = (Cycle, Classe, AnneeScolaire, Niveau)

# Champs obligatoires à la création : message clair (400) plutôt qu'une
# IntegrityError renvoyée comme « violation d'unicité » (409).
CHAMPS_REQUIS = {
    Cycle: ('libelle',),
    Classe: ('cycle_id',),
    AnneeScolaire: ('libelle',),
    Trimestre: ('annee_scolaire_id', 'libelle'),
    Sequence: ('trimestre_id', 'libelle'),
    Niveau: ('libelle',),
}


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

    if model_class is Classe and data.get('niveau_id') not in (None, ''):
        niveau = db.session.get(Niveau, data['niveau_id'])
        if not niveau or niveau.etablissement_id != etablissement_id:
            return "Niveau invalide pour cet établissement"
    if model_class is Classe and data.get('niveau_id') == '':
        data['niveau_id'] = None

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
    except IntegrityError as e:
        db.session.rollback()
        # DIAGNOSTIC TEMPORAIRE : le message générique ci-dessous ("Violation
        # de contrainte d'unicité") est renvoyé pour TOUTE IntegrityError, pas
        # seulement les doublons — une violation de clé étrangère, de NOT
        # NULL, de CHECK, ou une collision de clé primaire (séquence
        # désynchronisée après un seed en base) déclenchent exactement la
        # même IntegrityError. On logue donc ici le détail réel (nom de
        # contrainte, message SQL brut) côté serveur, pour pouvoir
        # diagnostiquer avec certitude au lieu de deviner à partir du seul
        # message générique renvoyé au frontend.
        current_app.logger.error(
            "IntegrityError sur %s : %s", model_class.__name__, getattr(e, "orig", e)
        )
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
    except IntegrityError as e:
        db.session.rollback()
        current_app.logger.error(
            "IntegrityError sur update %s : %s", type(entity).__name__, getattr(e, "orig", e)
        )
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
    except IntegrityError as e:
        db.session.rollback()
        # Une clé étrangère (ou une contrainte NOT NULL sur la clé de
        # rattachement) empêche la suppression : l'élément est encore utilisé
        # ailleurs. Ce n'est pas une panne serveur (409, pas 500) ; le détail
        # réel est loggé car il n'est jamais montré à l'utilisateur.
        current_app.logger.warning(
            "IntegrityError sur delete %s : %s", type(entity).__name__, getattr(e, "orig", e)
        )
        return {"erreur": "Suppression impossible : cet élément est encore utilisé par d'autres "
                          "enregistrements. Supprimez ou détachez d'abord ceux-ci."}, 409
    except Exception:
        db.session.rollback()
        current_app.logger.exception("Erreur inattendue sur delete %s", type(entity).__name__)
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
    data.pop('code', None)  # attribué automatiquement (cf. Etablissement.code)
    if not data.get('mode_evaluation'):
        data.pop('mode_evaluation', None)  # défaut du modèle : Lycée
    error = _erreur_mode_evaluation(data) or _preparer_modele_bulletin(data)
    if error:
        return {"erreur": error}, 400
    try:
        if logo_file and getattr(logo_file, 'filename', None):
            data['logo'] = save_logo_file(logo_file, data.get('nom', ''))
    except ValueError as e:
        return {"erreur": str(e)}, 400
    result, status = create_entity(Etablissement, data)
    if status >= 400:
        delete_logo_file(data.get('logo'))  # pas de fichier orphelin
    return result, status


def update_etablissement(entity, data, logo_file=None):
    """Le nom du fichier logo est indépendant du nom de l'établissement
    (suffixe aléatoire) : renommer l'établissement ne touche plus au
    fichier. Un nouveau logo remplace l'ancien, supprimé APRÈS la mise à
    jour réussie de la base."""
    data = dict(data or {})
    data.pop('logo', None)
    data.pop('code', None)  # jamais modifiable
    if not data.get('mode_evaluation'):
        data.pop('mode_evaluation', None)
    error = _erreur_mode_evaluation(data) or _preparer_modele_bulletin(data, entity)
    if error:
        return {"erreur": error}, 400
    ancien_logo = entity.logo
    try:
        if logo_file and getattr(logo_file, 'filename', None):
            data['logo'] = save_logo_file(logo_file, data.get('nom') or entity.nom)
    except ValueError as e:
        return {"erreur": str(e)}, 400
    result, status = update_entity(entity, data)
    if 'logo' in data:
        delete_logo_file(data['logo'] if status >= 400 else ancien_logo)
    return result, status


# ---------------------------------------------------------------------------
# CRUD cloisonné par établissement (Cycle, Classe, AnneeScolaire, Trimestre, Sequence)
# ---------------------------------------------------------------------------

def get_all_entities_scoped(model_class, etablissement_id, classe_ids_restriction=None):
    entities = scoped_query(model_class, etablissement_id, classe_ids_restriction).all()
    if model_class is Classe:
        # Effectifs calculés en UNE requête pour toute la liste (au lieu
        # d'une requête par classe).
        effectifs = effectifs_classes(etablissement_id, [c.id for c in entities])
        return [c.to_dict(effectif=effectifs.get(c.id, 0)) for c in entities]
    return [e.to_dict() for e in entities]


def _desactiver_autres_annees(data, etablissement_id, annee_id=None):
    """Une seule année scolaire active par établissement : activer une
    année désactive les autres DANS LA MÊME transaction (commit fait par
    create_entity/update_entity). Auparavant seul le front s'en chargeait,
    par une série de requêtes non atomique."""
    if not data.get('active'):
        return
    query = AnneeScolaire.query.filter(AnneeScolaire.etablissement_id == etablissement_id,
                                       AnneeScolaire.active.is_(True))
    if annee_id is not None:
        query = query.filter(AnneeScolaire.id != annee_id)
    for autre in query.all():
        autre.active = False


def _erreur_mode_evaluation(data):
    from services.mode_evaluation_services import mode_valide
    if 'mode_evaluation' in data and not mode_valide(data['mode_evaluation']):
        return "Mode d'évaluation invalide (attendu : lycee, college ou institut)"
    return None


def _preparer_modele_bulletin(data, etablissement=None):
    """Modèle de bulletin d'un établissement : il doit appartenir à son mode
    d'évaluation. Non précisé (ou vide), on garde le modèle actuel s'il reste
    compatible avec le mode, sinon on revient au modèle par défaut du mode. Retourne
    un message d'erreur ou None."""
    from models.structure_models import MODELES_BULLETIN, MODES_EVALUATION
    from services.mode_evaluation_services import modele_bulletin_compatible, modele_bulletin_defaut, normaliser_mode
    mode = normaliser_mode(data.get('mode_evaluation') or (etablissement.mode_evaluation if etablissement else None))
    code = data.get('modele_bulletin') or None
    if code is None:
        actuel = etablissement.modele_bulletin if etablissement else None
        data['modele_bulletin'] = actuel if modele_bulletin_compatible(actuel, mode) else modele_bulletin_defaut(mode)
        return None
    if code not in MODELES_BULLETIN:
        return "Modèle de bulletin inconnu"
    if not modele_bulletin_compatible(code, mode):
        return (f"Le modèle de bulletin « {MODELES_BULLETIN[code]['libelle']} » n'appartient pas "
                f"au mode d'évaluation {MODES_EVALUATION[mode]['libelle']}")
    return None


def _preparer_mode_annee(data, etablissement_id, annee=None):
    """Mode d'évaluation d'une année : à la création, celui de
    l'établissement s'il n'est pas précisé ; ensuite modifiable tant
    qu'aucune note n'a été saisie dans l'année (définitif après). Retourne
    un message d'erreur ou None."""
    error = _erreur_mode_evaluation(data)
    if error:
        return error
    if annee is None:
        if not data.get('mode_evaluation'):
            etablissement = db.session.get(Etablissement, etablissement_id)
            data['mode_evaluation'] = etablissement.mode_evaluation if etablissement else None
        return None
    if 'mode_evaluation' in data and data['mode_evaluation'] != annee.mode_evaluation and annee.mode_verrouille:
        return ("Le mode d'évaluation de cette année ne peut plus être modifié : "
                "des notes ont déjà été saisies.")
    return None


def _preparer_etat_saisie(data, sequence=None):
    """État de la saisie des notes d'une séquence (cf. Sequence) : valeur
    contrôlée ; cloturee_le est posé par le serveur à la clôture, jamais
    reçu du client. Retourne un message d'erreur ou None."""
    from datetime import datetime
    from models.structure_models import ETATS_SAISIE
    data.pop('cloturee_le', None)
    data.pop('verrouillee', None)
    if 'etat_saisie' not in data:
        return None
    etat = data['etat_saisie'] or 'auto'
    if etat not in ETATS_SAISIE:
        return "État de saisie invalide (attendu : auto, cloturee ou ouverte)"
    data['etat_saisie'] = etat
    if etat == 'cloturee' and (sequence is None or sequence.etat_saisie != 'cloturee'):
        data['cloturee_le'] = datetime.utcnow()
    elif etat != 'cloturee':
        data['cloturee_le'] = None
    return None


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

    for champ in CHAMPS_REQUIS.get(model_class, ()):
        if data.get(champ) in (None, ''):
            return {"erreur": f"{champ} requis"}, 400

    error = _validate_foreign_keys_scoped(model_class, data, etablissement_id)
    if error:
        return {"erreur": error}, 400

    if model_class is AnneeScolaire:
        error = _preparer_mode_annee(data, etablissement_id)
        if error:
            return {"erreur": error}, 400
    if model_class is Sequence:
        error = _preparer_etat_saisie(data)
        if error:
            return {"erreur": error}, 400
        _desactiver_autres_annees(data, etablissement_id)

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

    if isinstance(entity, AnneeScolaire):
        error = _preparer_mode_annee(data, etablissement_id, entity)
        if error:
            return {"erreur": error}, 400
        _desactiver_autres_annees(data, etablissement_id, entity.id)
    if isinstance(entity, Sequence):
        error = _preparer_etat_saisie(data, entity)
        if error:
            return {"erreur": error}, 400

    return update_entity(entity, data)


def delete_entity_scoped(entity, etablissement_id, classe_ids_restriction=None):
    if get_etablissement_id_of(entity) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    if (isinstance(entity, Classe) and classe_ids_restriction is not None
            and entity.id not in classe_ids_restriction):
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403
    if isinstance(entity, Niveau):
        # Les classes du niveau reviennent au niveau déduit de leur nom.
        for classe in entity.classes:
            classe.niveau_id = None
    return delete_entity(entity)


def generer_niveaux(etablissement_id):
    """Crée les niveaux manquants à partir du nom des classes (« 6e A » et
    « 6e B » -> « 6E ») et y range les classes qui n'en ont pas encore.
    Retourne {crees, classes_rangees}."""
    from services.bulletin_services import libelle_niveau_deduit
    existants = {n.libelle.lower(): n for n in Niveau.query.filter_by(etablissement_id=etablissement_id).all()}
    crees = rangees = 0
    for classe in Classe.query.filter_by(etablissement_id=etablissement_id, niveau_id=None).all():
        libelle = libelle_niveau_deduit(classe)
        niveau = existants.get(libelle.lower())
        if niveau is None:
            niveau = Niveau(etablissement_id=etablissement_id, libelle=libelle, ordre=len(existants) + 1)
            db.session.add(niveau)
            db.session.flush()
            existants[libelle.lower()] = niveau
            crees += 1
        classe.niveau_id = niveau.id
        rangees += 1
    db.session.commit()
    return {"crees": crees, "classes_rangees": rangees}


# ---------------------------------------------------------------------------
# Suppression d'une classe (avec ou sans cascade)
#
# Une classe est référencée (clé étrangère NOT NULL, sans cascade) par ses
# inscriptions, ses matières (MatiereClasse, qui portent à leur tour notes,
# horaires et épreuves), ses tranches de paiement, ses titulaires et les
# Censeurs/Surveillants assignés. Classe vide -> suppression simple. Sinon on
# refuse par défaut (409 + détail chiffré) ; l'interface affiche ce détail et,
# si l'administrateur confirme, redemande avec ?cascade=1 : tout ce qui est
# rattaché à la classe part dans UNE seule transaction (tout ou rien).
# Les ÉLÈVES eux-mêmes ne sont pas supprimés : seule leur inscription dans
# cette classe l'est (avec ses notes, fiches de discipline et paiements).
# ---------------------------------------------------------------------------

_LIBELLES_LIENS_CLASSE = (
    ('inscriptions', 'élève inscrit', 'élèves inscrits'),
    ('notes', 'note', 'notes'),
    ('disciplines', 'fiche de discipline', 'fiches de discipline'),
    ('paiements', 'paiement', 'paiements'),
    ('tranches', 'tranche de paiement', 'tranches de paiement'),
    ('matieres', 'matière', 'matières'),
    ('horaires', "créneau d'emploi du temps", "créneaux d'emploi du temps"),
    ('epreuves', 'épreuve', 'épreuves'),
    ('titulaires', 'titulaire', 'titulaires'),
    ('censeurs', 'censeur assigné', 'censeurs assignés'),
    ('surveillants', 'surveillant assigné', 'surveillants assignés'),
)


def _collecter_liens_classe(classe):
    """Lignes rattachées à la classe, par famille ({famille: [objets]})."""
    from models.inscription_models import Inscription
    from models.evaluation_models import Note, Discipline
    from models.paiements_models import Paiement, LignePaiement, TrancheClasse
    from models.pedagogie_models import MatiereClasse, TitulaireClasse, CenseurClasse, SurveillantClasse
    from models.emploi_du_temps_models import Horaire
    from models.epreuve_models import Epreuve

    inscriptions = Inscription.query.filter_by(classe_id=classe.id).all()
    insc_ids = [i.id for i in inscriptions]
    matieres = MatiereClasse.query.filter_by(classe_id=classe.id).all()
    mc_ids = [m.id for m in matieres]
    tranches = TrancheClasse.query.filter_by(classe_id=classe.id).all()
    tranche_ids = [t.id for t in tranches]

    paiements = Paiement.query.filter(Paiement.inscription_id.in_(insc_ids)).all() if insc_ids else []
    paiement_ids = {p.id for p in paiements}
    # Lignes des paiements supprimés + éventuelles lignes pointant sur une
    # tranche de cette classe (sans quoi la clé étrangère bloquerait).
    lignes = {}
    if paiement_ids:
        for ligne in LignePaiement.query.filter(LignePaiement.paiement_id.in_(paiement_ids)).all():
            lignes[ligne.id] = ligne
    if tranche_ids:
        for ligne in LignePaiement.query.filter(LignePaiement.tranche_classe_id.in_(tranche_ids)).all():
            lignes[ligne.id] = ligne

    # Notes : celles des élèves de la classe ET celles saisies sur ses matières
    # (un élève changé de classe garde des notes rattachées à l'ancienne).
    notes = {}
    if insc_ids:
        for n in Note.query.filter(Note.inscription_id.in_(insc_ids)).all():
            notes[n.id] = n
    if mc_ids:
        for n in Note.query.filter(Note.matiere_classe_id.in_(mc_ids)).all():
            notes[n.id] = n

    return {
        'inscriptions': inscriptions,
        'notes': list(notes.values()),
        'disciplines': Discipline.query.filter(Discipline.inscription_id.in_(insc_ids)).all() if insc_ids else [],
        'paiements': paiements,
        'lignes_paiement': list(lignes.values()),
        'tranches': tranches,
        'matieres': matieres,
        'horaires': Horaire.query.filter(Horaire.matiere_classe_id.in_(mc_ids)).all() if mc_ids else [],
        'epreuves': Epreuve.query.filter(Epreuve.matiere_classe_id.in_(mc_ids)).all() if mc_ids else [],
        'titulaires': TitulaireClasse.query.filter_by(classe_id=classe.id).all(),
        'censeurs': CenseurClasse.query.filter_by(classe_id=classe.id).all(),
        'surveillants': SurveillantClasse.query.filter_by(classe_id=classe.id).all(),
    }


def liens_classe(classe):
    """{famille: nombre} des seules familles non vides ({} = classe vide)."""
    liens = _collecter_liens_classe(classe)
    return {cle: len(liens[cle]) for cle, _, _ in _LIBELLES_LIENS_CLASSE if liens[cle]}


def _decrire_liens_classe(comptes):
    morceaux = [f"{comptes[cle]} {sing if comptes[cle] == 1 else plur}"
                for cle, sing, plur in _LIBELLES_LIENS_CLASSE if cle in comptes]
    if len(morceaux) > 1:
        return ', '.join(morceaux[:-1]) + ' et ' + morceaux[-1]
    return morceaux[0] if morceaux else ''


def _supprimer_classe_en_cascade(classe):
    from models.epreuve_models import Epreuve
    try:
        liens = _collecter_liens_classe(classe)
        comptes = {cle: len(liens[cle]) for cle, _, _ in _LIBELLES_LIENS_CLASSE}
        fichiers_epreuves = [(e.etablissement_id, e.fichier) for e in liens['epreuves']]

        # Ordre : du plus dépendant au moins dépendant, avec un flush entre
        # chaque niveau pour que les DELETE partent dans le bon ordre.
        for famille in (('lignes_paiement',), ('paiements', 'notes', 'disciplines', 'horaires', 'epreuves'),
                        ('inscriptions', 'matieres', 'tranches', 'titulaires', 'censeurs', 'surveillants')):
            for cle in famille:
                for objet in liens[cle]:
                    db.session.delete(objet)
            db.session.flush()
        db.session.delete(classe)
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception("Échec de la suppression en cascade de la classe %s", classe.id)
        return {"erreur": "Erreur lors de la suppression : rien n'a été supprimé."}, 500

    # Fichiers d'épreuves retirés du disque seulement APRÈS le commit réussi.
    from services.epreuve_services import delete_epreuve_file
    for etab_id, fichier in fichiers_epreuves:
        delete_epreuve_file(etab_id, fichier)
    return {"message": "Classe et données rattachées supprimées", "supprime": comptes}, 200


def supprimer_classe(classe, etablissement_id, classe_ids_restriction=None, cascade=False):
    """Classe vide -> supprimée. Classe liée -> 409 détaillé, sauf cascade=True."""
    if get_etablissement_id_of(classe) != etablissement_id:
        return {"erreur": "Accès non autorisé à cette ressource"}, 403
    if classe_ids_restriction is not None and classe.id not in classe_ids_restriction:
        return {"erreur": "Classe non assignée : vous n'avez pas la charge de cette classe"}, 403
    comptes = liens_classe(classe)
    if not comptes:
        return delete_entity(classe)
    if not cascade:
        return {
            "erreur": f"Cette classe est liée à {_decrire_liens_classe(comptes)}. "
                      "Confirmez la suppression définitive pour tout supprimer.",
            "code": "classe_liee",
            "details": comptes,
        }, 409
    return _supprimer_classe_en_cascade(classe)

