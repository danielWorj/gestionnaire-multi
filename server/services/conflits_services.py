"""Détection des conflits lors de la synchronisation des saisies hors
connexion (et des enregistrements concurrents en ligne).

Protocole, commun à tous les modules (notes, discipline, inscriptions…) :

- le client envoie, avec sa saisie, `version_base` : la version de la donnée
  qu'il avait sous les yeux (null s'il croyait qu'elle n'existait pas) ;
- si la donnée a changé entre-temps (version différente), ou existe déjà
  alors qu'il pensait la créer, le serveur N'ÉCRIT RIEN et répond 409 avec :
    code          'conflit' (modifiée entre-temps) ou 'doublon' (existe déjà)
    serveur       la donnée telle qu'elle est en base
    modification  la dernière entrée du journal d'audit : qui, quand, quoi
  pour que l'utilisateur tranche en connaissance de cause ;
- s'il choisit d'écraser, le client renvoie la même saisie avec
  `forcer: true` ; s'il choisit d'ignorer, il n'envoie rien.

Une saisie identique à ce qui est déjà en base n'est jamais un conflit
(renvoi d'une requête dont la réponse s'est perdue, par exemple).
"""
from dataclasses import dataclass
from typing import Optional
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import inspect

from models.audit_models import JournalAudit


@dataclass
class Controle:
    version_base: Optional[int]
    forcer: bool
    fourni: bool  # le client a-t-il participé au protocole (clé version_base présente) ?


def extraire_controle(data):
    """Retire version_base / forcer du payload (ce ne sont pas des colonnes)."""
    fourni = 'version_base' in data
    brut = data.pop('version_base', None)
    forcer = bool(data.pop('forcer', False))
    try:
        version_base = int(brut) if brut is not None else None
    except (TypeError, ValueError):
        version_base = None
    return Controle(version_base=version_base, forcer=forcer, fourni=fourni)


def derniere_modification(entity):
    state = inspect(entity)
    table = state.mapper.local_table.name
    ligne_id = '-'.join(str(v) for v in state.identity) if state.identity else str(getattr(entity, 'id', ''))
    entree = (JournalAudit.query.filter_by(table_nom=table, ligne_id=ligne_id)
              .order_by(JournalAudit.id.desc()).first())
    return entree.to_dict() if entree else None


def reponse_conflit(entity, code, message, serveur=None):
    return {
        "erreur": message,
        "code": code,
        "serveur": serveur if serveur is not None else entity.to_dict(),
        "modification": derniere_modification(entity),
    }, 409


def _normaliser(valeur):
    if valeur == '':
        return None
    if isinstance(valeur, bool) or valeur is None:
        return valeur
    if isinstance(valeur, (int, float, Decimal)):
        return float(valeur)
    if isinstance(valeur, (datetime, date)):
        return valeur.isoformat()
    return str(valeur).strip()


def memes_valeurs(entity, valeurs):
    """Vrai si l'entité porte déjà exactement ces valeurs (tolérant aux types :
    12 == 12.0 == Decimal('12.00'), '' == None, date == 'AAAA-MM-JJ')."""
    for cle, attendu in valeurs.items():
        actuel, attendu = _normaliser(getattr(entity, cle, None)), _normaliser(attendu)
        if isinstance(actuel, bool) or isinstance(attendu, bool):
            actuel, attendu = bool(actuel), bool(attendu)
        if actuel != attendu:
            return False
    return True


def verifier(entity, controle, valeurs, *, message_conflit, message_doublon=None, creation=False):
    """Retourne une réponse 409 s'il faut demander l'avis de l'utilisateur,
    None si l'écriture peut se faire.

    creation=True : le client voulait CRÉER (il ne connaissait pas `entity`) :
    c'est un doublon, sauf s'il annonce la version qu'il a vue.
    Sans participation au protocole (anciens clients, outils internes), aucun
    contrôle : comportement historique inchangé."""
    if controle.forcer or not controle.fourni or memes_valeurs(entity, valeurs):
        return None
    if controle.version_base is None:
        if creation:
            return reponse_conflit(entity, 'doublon', message_doublon or message_conflit)
        return None
    if controle.version_base != entity.version:
        return reponse_conflit(entity, 'conflit', message_conflit)
    return None
