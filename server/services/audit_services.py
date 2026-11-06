"""Audit automatique de toutes les écritures (qui a créé / modifié / supprimé
quoi, et quand) et versionnage des tables synchronisées hors connexion.

Branché sur les événements de la Session SQLAlchemy (cf. activer_audit,
appelé par create_app) : AUCUN service n'a à s'en soucier, toute écriture
passant par l'ORM est journalisée, y compris les imports.

Garantie : les lignes du journal sont insérées sur la connexion de la
transaction en cours, pendant le flush. Si leur écriture échoue, le flush —
donc la modification — échoue aussi et la transaction est annulée : aucune
donnée ne change sans laisser de trace.

Hors du périmètre (pas de valeur métier, ou écrits hors ORM) : le journal
lui-même, les sessions de connexion et la liste des jetons révoqués.
"""
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
import enum

from flask import has_request_context, request
from sqlalchemy import event, inspect, select
from sqlalchemy.orm import Session

from models.audit_models import JournalAudit, Versionne

TABLES_EXCLUES = {'journal_audit', 'session_connexion', 'token_blocklist'}

# Écritures techniques sans intérêt pour l'historique (chaque connexion les
# modifie) : ignorées ; si une modification ne touche qu'elles, rien n'est
# journalisé.
COLONNES_TECHNIQUES = {
    'utilisateur': {'dernier_login', 'echecs_connexion', 'verrouille_jusqua'},
    'super_admin': {'dernier_login', 'echecs_connexion', 'verrouille_jusqua'},
}
COLONNES_TOUJOURS_IGNOREES = {'version'}

# Jamais en clair dans le journal : on trace seulement qu'ils ont changé.
COLONNES_SECRETES = {'mot_de_passe_hash', 'token_hash', 'token_precedent_hash'}
MASQUE_SECRET = '••••••'

# En-tête posé par le front lors de l'envoi d'une donnée saisie hors
# connexion (heure de saisie sur l'appareil, ISO 8601).
ENTETE_HORS_LIGNE = 'X-Saisi-Hors-Ligne-Le'

_CLE_ACTEUR = 'gestionnaire.audit_acteur'

ACTIONS = {'creation': 'creation', 'modification': 'modification', 'suppression': 'suppression'}


# ---------------------------------------------------------------------------
# Valeurs et colonnes
# ---------------------------------------------------------------------------

def _serialiser(valeur):
    if valeur is None or isinstance(valeur, (bool, int, float, str)):
        return valeur
    if isinstance(valeur, Decimal):
        return float(valeur)
    if isinstance(valeur, (datetime, date, time)):
        return valeur.isoformat()
    if isinstance(valeur, enum.Enum):
        return _serialiser(valeur.value)
    if isinstance(valeur, (bytes, bytearray, memoryview)):
        return None
    if isinstance(valeur, (list, tuple)):
        return [_serialiser(v) for v in valeur]
    if isinstance(valeur, dict):
        return {str(k): _serialiser(v) for k, v in valeur.items()}
    return str(valeur)


def _valeur_journal(cle, valeur):
    if cle in COLONNES_SECRETES:
        return MASQUE_SECRET if valeur is not None else None
    return _serialiser(valeur)


def _cles_auditees(state):
    table = state.mapper.local_table.name
    ignorees = COLONNES_TOUJOURS_IGNOREES | COLONNES_TECHNIQUES.get(table, set())
    return [attr.key for attr in state.mapper.column_attrs if attr.key not in ignorees]


def _table(state):
    return state.mapper.local_table.name


def _ligne_id(state):
    valeurs = state.identity or [
        state.dict.get(state.mapper.get_property_by_column(col).key) for col in state.mapper.primary_key
    ]
    return '-'.join('' if v is None else str(v) for v in valeurs)


# ---------------------------------------------------------------------------
# Auteur de l'action (mis en cache sur la requête elle-même : `g` vit le
# temps du contexte applicatif, qui peut couvrir plusieurs requêtes)
# ---------------------------------------------------------------------------

def _lire_heure_hors_ligne():
    brut = request.headers.get(ENTETE_HORS_LIGNE)
    if not brut:
        return None
    try:
        moment = datetime.fromisoformat(brut.strip().replace('Z', '+00:00'))
    except ValueError:
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    # Une heure de saisie dans le futur (horloge de l'appareil déréglée)
    # n'a pas de sens : ignorée plutôt que de fausser l'historique.
    if moment > datetime.utcnow() + timedelta(minutes=5):
        return None
    return moment


def heure_saisie_hors_ligne():
    """Heure réelle de la saisie sur l'appareil pour une donnée saisie hors
    connexion puis synchronisée (None sinon, ou hors requête)."""
    return _lire_heure_hors_ligne() if has_request_context() else None


def _acteur(connexion):
    if not has_request_context():
        return {'auteur_type': 'systeme', 'auteur_id': None, 'auteur_nom': 'Système', 'auteur_role': None,
                'adresse_ip': None, 'saisi_hors_ligne_le': None, 'etablissement_id': None}

    acteur = request.environ.get(_CLE_ACTEUR)
    if acteur is not None:
        return acteur

    claims, identite = {}, None
    try:
        from flask_jwt_extended import get_jwt, get_jwt_identity
        claims = get_jwt() or {}
        identite = get_jwt_identity()
    except Exception:
        claims, identite = {}, None

    type_compte = claims.get('type_compte')
    auteur_id, auteur_nom = None, None
    if type_compte in ('utilisateur', 'superadmin') and identite is not None:
        try:
            auteur_id = int(identite)
        except (TypeError, ValueError):
            auteur_id = None
    if auteur_id is not None:
        # Import tardif : évite un import circulaire au chargement des modèles.
        from models.authentification_models import SuperAdmin, Utilisateur
        modele = SuperAdmin if type_compte == 'superadmin' else Utilisateur
        auteur_nom = connexion.execute(select(modele.nom).where(modele.id == auteur_id)).scalar()
    else:
        type_compte = 'anonyme'

    etablissement_id = claims.get('etablissement_id')
    if etablissement_id is None and type_compte == 'superadmin':
        etablissement_id = request.args.get('etablissement_id', type=int)

    acteur = {
        'auteur_type': type_compte,
        'auteur_id': auteur_id,
        'auteur_nom': auteur_nom,
        'auteur_role': 'SuperAdmin' if type_compte == 'superadmin' else claims.get('role'),
        'adresse_ip': (request.remote_addr or '')[:45] or None,
        'saisi_hors_ligne_le': _lire_heure_hors_ligne(),
        'etablissement_id': etablissement_id,
    }
    # Pas de cache tant que l'auteur est inconnu : pendant la connexion, le
    # compte n'est identifié qu'après l'émission des jetons.
    if type_compte != 'anonyme':
        request.environ[_CLE_ACTEUR] = acteur
    return acteur


# ---------------------------------------------------------------------------
# Construction des entrées
# ---------------------------------------------------------------------------

def _changements_creation(state):
    return {cle: [None, _valeur_journal(cle, state.dict.get(cle))]
            for cle in _cles_auditees(state) if state.dict.get(cle) is not None}


def _changements_suppression(state):
    # state.dict : valeurs déjà chargées uniquement (la ligne n'existe plus en
    # base, un chargement différé échouerait).
    return {cle: [_valeur_journal(cle, state.dict.get(cle)), None]
            for cle in _cles_auditees(state) if state.dict.get(cle) is not None}


def _changements_modification(state):
    changements = {}
    for cle in _cles_auditees(state):
        historique = state.attrs[cle].history
        if not historique.has_changes():
            continue
        avant = historique.deleted[0] if historique.deleted else None
        apres = historique.added[0] if historique.added else None
        if avant == apres:
            continue
        changements[cle] = [_valeur_journal(cle, avant), _valeur_journal(cle, apres)]
    return changements


def _entree(state, action, changements, acteur):
    # state.dict et non getattr : jamais de chargement différé pendant le
    # flush (une ligne supprimée ne peut plus être relue).
    etablissement_id = state.dict.get('etablissement_id')
    return {
        'horodatage': datetime.utcnow(),
        'action': action,
        'table_nom': _table(state),
        'ligne_id': _ligne_id(state),
        'version_ligne': state.dict.get('version') if isinstance(state.obj(), Versionne) else None,
        'etablissement_id': etablissement_id if etablissement_id is not None else acteur['etablissement_id'],
        'auteur_type': acteur['auteur_type'],
        'auteur_id': acteur['auteur_id'],
        'auteur_nom': acteur['auteur_nom'],
        'auteur_role': acteur['auteur_role'],
        'adresse_ip': acteur['adresse_ip'],
        'saisi_hors_ligne_le': acteur['saisi_hors_ligne_le'],
        'changements': changements,
    }


# ---------------------------------------------------------------------------
# Écouteurs de Session
# ---------------------------------------------------------------------------

def _avant_flush(session, _contexte, _instances):
    """Versionnage : +1 à chaque modification effective d'une table Versionne."""
    for obj in list(session.dirty):
        if not isinstance(obj, Versionne) or not session.is_modified(obj, include_collections=False):
            continue
        state = inspect(obj)
        if any(state.attrs[cle].history.has_changes() for cle in _cles_auditees(state)):
            obj.version = (obj.version or 1) + 1


def _apres_flush(session, _contexte):
    """Journalisation, dans la transaction en cours (cf. docstring du module).
    À ce stade, new/dirty/deleted et l'historique des attributs reflètent
    encore ce qui vient d'être écrit."""
    a_journaliser = []
    for obj in session.new:
        state = inspect(obj)
        if _table(state) not in TABLES_EXCLUES:
            a_journaliser.append((state, ACTIONS['creation'], _changements_creation(state)))
    for obj in session.dirty:
        state = inspect(obj)
        if _table(state) in TABLES_EXCLUES or not session.is_modified(obj, include_collections=False):
            continue
        changements = _changements_modification(state)
        if changements:
            a_journaliser.append((state, ACTIONS['modification'], changements))
    for obj in session.deleted:
        state = inspect(obj)
        if _table(state) not in TABLES_EXCLUES:
            a_journaliser.append((state, ACTIONS['suppression'], _changements_suppression(state)))

    if not a_journaliser:
        return
    connexion = session.connection()
    acteur = _acteur(connexion)
    connexion.execute(
        JournalAudit.__table__.insert(),
        [_entree(state, action, changements, acteur) for state, action, changements in a_journaliser],
    )


_active = False


def activer_audit():
    """Branche l'audit sur toutes les Sessions (une seule fois par processus,
    même si create_app est appelé plusieurs fois, ex. tests)."""
    global _active
    if _active:
        return
    event.listen(Session, 'before_flush', _avant_flush)
    event.listen(Session, 'after_flush', _apres_flush)
    _active = True
