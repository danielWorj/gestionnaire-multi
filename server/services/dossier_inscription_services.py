"""Dossier d'inscription : parent, élève et inscription enregistrés en UNE
transaction (tout ou rien).

Pensé pour la saisie hors connexion : sur l'appareil, rien n'a encore
d'identifiant (le parent créé n'a pas d'id à donner à l'élève, ni l'élève à
l'inscription) ; le dossier complet part donc en une seule requête au retour
du réseau. Sert aussi en ligne (plus de parent ou d'élève orphelin si
l'inscription échoue en cours de route).

Doublons détectés (rien n'est écrit, 409 'doublon', l'utilisateur tranche) :
  - parent  : même e-mail dans l'établissement (contrainte d'unicité) ;
  - élève   : même matricule dans l'établissement ;
  - inscription : l'élève est déjà inscrit pour cette année scolaire.
Une fiche existante identique à la saisie n'est pas un doublon : elle est
simplement réutilisée (renvoi d'un dossier déjà enregistré).

« Écraser » (forcer=True) : la fiche existante reçoit les valeurs saisies et
est réutilisée — l'inscription existante de l'année change donc de classe.
"""
from datetime import date

from sqlalchemy.exc import IntegrityError

from extensions import db
from models.inscription_models import Eleve, Inscription, Parent
from models.structure_models import Classe
from services.conflits_services import derniere_modification, memes_valeurs
from services.inscription_services import CHAMPS_REQUIS, _validate_foreign_keys_scoped

CHAMPS_PARENT = ('nom', 'prenom', 'telephone', 'email')
CHAMPS_ELEVE = ('matricule', 'nom', 'prenom', 'sexe', 'date_naissance', 'lieu_naissance', 'statut')
CHAMPS_INSCRIPTION = ('classe_id', 'annee_scolaire_id', 'date_inscription', 'statut')


class _Refus(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def _nettoyer(data, champs):
    propre = {}
    for cle in champs:
        if cle in data:
            v = data[cle]
            propre[cle] = v.strip() if isinstance(v, str) else v
    return propre


def _date(valeur, champ):
    if valeur in (None, ''):
        return None
    if isinstance(valeur, date):
        return valeur
    try:
        return date.fromisoformat(str(valeur)[:10])
    except ValueError as e:
        raise _Refus(f"{champ} invalide (format attendu : AAAA-MM-JJ)") from e


def _requis(model, data, exclus=()):
    for champ in CHAMPS_REQUIS[model]:
        if champ not in exclus and data.get(champ) in (None, ''):
            raise _Refus(f"{champ} requis")


def _doublon(type_, existant, saisie):
    return {"type": type_, "serveur": existant.to_dict(), "saisie": saisie,
            "modification": derniere_modification(existant)}


def _classe_label(classe_id):
    classe = db.session.get(Classe, classe_id) if classe_id else None
    if not classe:
        return None
    cycle = getattr(getattr(classe, 'cycle', None), 'libelle', None)
    return ' '.join(x for x in (cycle, classe.option) if x) or f"Classe n°{classe.id}"


def _resume(parent, eleve, inscription):
    res = {}
    if parent is not None:
        res['parent'] = parent.to_dict()
    if eleve is not None:
        res['eleve'] = eleve.to_dict()
    if inscription is not None:
        res['inscription'] = {**inscription.to_dict(), 'classe_label': _classe_label(inscription.classe_id)}
    return res


def _appliquer(entity, valeurs):
    for cle, v in valeurs.items():
        setattr(entity, cle, v)


def enregistrer_dossier(data, etablissement_id):
    data = dict(data or {})
    forcer = bool(data.get('forcer'))
    doublons = []
    try:
        parent, eleve, inscription = _preparer(data, etablissement_id, forcer, doublons)
        if doublons:
            db.session.rollback()
            types = {'parent': 'un parent avec cet e-mail', 'eleve': 'un élève avec ce matricule',
                     'inscription': 'une inscription de cet élève pour cette année'}
            message = "Existe déjà sur le serveur : " + ', '.join(types[d['type']] for d in doublons) + '.'
            serveur = {d['type']: d['serveur'] for d in doublons}
            if 'inscription' in serveur:
                serveur['inscription'] = {**serveur['inscription'], 'classe_label': _classe_label(serveur['inscription'].get('classe_id'))}
            return {"erreur": message, "code": "doublon", "doublons": doublons, "serveur": serveur,
                    "modification": doublons[0]['modification']}, 409
        db.session.commit()
        return _resume(parent, eleve, inscription), 201
    except _Refus as e:
        db.session.rollback()
        return {"erreur": e.message}, e.status
    except IntegrityError:
        db.session.rollback()
        return {"erreur": "Violation de contrainte d'unicité (dossier déjà enregistré ?)"}, 409


def _preparer(data, etablissement_id, forcer, doublons):
    # ── Parent ──────────────────────────────────────────────────────────────
    parent = None
    saisie_parent = _nettoyer(data.get('parent') or {}, CHAMPS_PARENT)
    if saisie_parent:
        _requis(Parent, saisie_parent)
        existant = Parent.query.filter_by(etablissement_id=etablissement_id, email=saisie_parent['email']).first()
        if existant:
            if not memes_valeurs(existant, saisie_parent):
                if not forcer:
                    doublons.append(_doublon('parent', existant, saisie_parent))
                else:
                    _appliquer(existant, saisie_parent)
            parent = existant
        else:
            parent = Parent(etablissement_id=etablissement_id, **saisie_parent)
            db.session.add(parent)
            db.session.flush()
    elif data.get('parent_id') is not None:
        parent = db.session.get(Parent, int(data['parent_id']))
        if not parent or parent.etablissement_id != etablissement_id:
            raise _Refus("Parent invalide pour cet établissement")

    # ── Élève ───────────────────────────────────────────────────────────────
    eleve = None
    saisie_eleve = _nettoyer(data.get('eleve') or {}, CHAMPS_ELEVE)
    if saisie_eleve:
        if 'date_naissance' in saisie_eleve:
            saisie_eleve['date_naissance'] = _date(saisie_eleve['date_naissance'], 'date_naissance')
        if not saisie_eleve.get('statut'):
            saisie_eleve.pop('statut', None)
        if parent is not None:
            saisie_eleve['parent_id'] = parent.id
        _requis(Eleve, saisie_eleve, exclus=('parent_id',) if doublons else ())
        existant = Eleve.query.filter_by(etablissement_id=etablissement_id, matricule=saisie_eleve['matricule']).first()
        if existant:
            if not memes_valeurs(existant, saisie_eleve):
                if not forcer:
                    doublons.append(_doublon('eleve', existant, {**saisie_eleve, 'date_naissance': data['eleve'].get('date_naissance')}))
                else:
                    _appliquer(existant, saisie_eleve)
            eleve = existant
        elif not doublons:
            eleve = Eleve(etablissement_id=etablissement_id, **saisie_eleve)
            db.session.add(eleve)
            db.session.flush()
    elif data.get('eleve_id') is not None:
        eleve = db.session.get(Eleve, int(data['eleve_id']))
        if not eleve or eleve.etablissement_id != etablissement_id:
            raise _Refus("Élève invalide pour cet établissement")

    # ── Inscription ─────────────────────────────────────────────────────────
    inscription = None
    saisie_insc = _nettoyer(data.get('inscription') or {}, CHAMPS_INSCRIPTION)
    if saisie_insc:
        if eleve is None and not doublons:
            raise _Refus("eleve requis pour l'inscription")
        saisie_insc['date_inscription'] = _date(saisie_insc.get('date_inscription'), 'date_inscription')
        if not saisie_insc.get('statut'):
            saisie_insc.pop('statut', None)
        if eleve is not None:
            saisie_insc['eleve_id'] = eleve.id
        _requis(Inscription, saisie_insc, exclus=('eleve_id',) if eleve is None else ())
        erreur = _validate_foreign_keys_scoped(Inscription, saisie_insc, etablissement_id)
        if erreur:
            raise _Refus(erreur)
        existante = Inscription.query.filter_by(
            eleve_id=eleve.id, annee_scolaire_id=int(saisie_insc['annee_scolaire_id'])
        ).first() if eleve is not None and eleve.id is not None else None
        if existante:
            valeurs = {k: v for k, v in saisie_insc.items() if k != 'eleve_id'}
            if not memes_valeurs(existante, valeurs):
                if not forcer:
                    doublons.append(_doublon('inscription', existante, {**valeurs, 'date_inscription': data['inscription'].get('date_inscription')}))
                else:
                    _appliquer(existante, valeurs)
            inscription = existante
        elif not doublons:
            inscription = Inscription(**saisie_insc)
            db.session.add(inscription)

    if parent is None and eleve is None and inscription is None and not doublons:
        raise _Refus("Dossier vide : renseignez au moins un parent, un élève ou une inscription")
    db.session.flush()
    return parent, eleve, inscription
