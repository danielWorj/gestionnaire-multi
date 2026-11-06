"""Listes de classe (impression / export CSV), ouvertes à TOUS les profils
d'établissement, chacun sur son propre périmètre de classes :

  - Admin, SuperAdmin, Proviseur, Secretaire, Comptable : toutes les classes
    de l'établissement ;
  - Censeur, Surveillant : les classes qui leur sont assignées
    (resolve_classe_ids_restriction) ;
  - Enseignant : les classes où il a au moins une matière attribuée, ou dont
    il est titulaire.

Lecture seule. Les coordonnées des parents ne sont renvoyées qu'aux rôles qui
lisent déjà les parents ailleurs (cf. parent_bp dans inscription_api.py) :
la liste de classe n'élargit pas l'accès aux données personnelles."""
from extensions import db
from models.inscription_models import Eleve, Inscription, Parent
from models.pedagogie_models import MatiereClasse, TitulaireClasse
from models.structure_models import AnneeScolaire, Classe
from services.pedagogie_services import resolve_classe_ids_restriction, resolve_enseignant_profil

ROLES_TOUTES_CLASSES = ("Admin", "SuperAdmin", "Proviseur", "Secretaire", "Comptable")
ROLES_CLASSES_ASSIGNEES = ("Censeur", "Surveillant")
ROLES_LISTES_CLASSE = ROLES_TOUTES_CLASSES + ROLES_CLASSES_ASSIGNEES + ("Enseignant",)
# Rôles ayant déjà accès aux parents (lecture) : parent_bp.
ROLES_AVEC_PARENTS = ("Admin", "SuperAdmin", "Secretaire", "Comptable")


def classe_ids_accessibles(role, user_id, etab_id):
    """set() des classe_id de l'établissement que ce compte peut lister."""
    classes = db.session.query(Classe.id).filter(Classe.etablissement_id == etab_id)
    if role in ROLES_TOUTES_CLASSES:
        return {cid for (cid,) in classes.all()}
    if role in ROLES_CLASSES_ASSIGNEES:
        ids = resolve_classe_ids_restriction(role, user_id) or set()
    elif role == "Enseignant":
        profil = resolve_enseignant_profil(user_id)
        if profil is None:
            return set()
        ids = {cid for (cid,) in db.session.query(MatiereClasse.classe_id)
               .filter(MatiereClasse.enseignant_id == profil.id).all()}
        ids |= {cid for (cid,) in db.session.query(TitulaireClasse.classe_id)
                .filter(TitulaireClasse.enseignant_id == profil.id).all()}
    else:
        return set()
    if not ids:
        return set()
    # Toujours recoupé avec l'établissement courant.
    return {cid for (cid,) in classes.filter(Classe.id.in_(ids)).all()}


def _classe_json(classe):
    cycle = classe.cycle.libelle if classe.cycle else None
    return {"id": classe.id, "cycle_id": classe.cycle_id, "cycle_libelle": cycle, "option": classe.option}


def contexte_listes(role, user_id, etab_id):
    """Classes accessibles et années scolaires de l'établissement."""
    ids = classe_ids_accessibles(role, user_id, etab_id)
    classes = Classe.query.filter(Classe.id.in_(ids)).all() if ids else []
    annees = (AnneeScolaire.query.filter_by(etablissement_id=etab_id)
              .order_by(AnneeScolaire.id.desc()).all())
    return {
        "classes": [_classe_json(c) for c in classes],
        "annees_scolaires": [{"id": a.id, "libelle": a.libelle, "active": bool(a.active)} for a in annees],
        "avec_parents": role in ROLES_AVEC_PARENTS,
    }


def eleves_listes(role, user_id, etab_id, annee_id, classe_id=None):
    """Une ligne par inscription (tous statuts : le filtre se fait à
    l'écran) des classes accessibles, pour l'année demandée. (None, 403) si
    la classe demandée n'est pas dans le périmètre."""
    ids = classe_ids_accessibles(role, user_id, etab_id)
    if classe_id is not None:
        if classe_id not in ids:
            return None, 403
        ids = {classe_id}
    if not ids:
        return [], 200

    annee = AnneeScolaire.query.filter_by(id=annee_id, etablissement_id=etab_id).first()
    if annee is None:
        return [], 200

    avec_parents = role in ROLES_AVEC_PARENTS
    requete = (db.session.query(Inscription, Eleve, Parent)
               .join(Eleve, Eleve.id == Inscription.eleve_id)
               .outerjoin(Parent, Parent.id == Eleve.parent_id)
               .filter(Inscription.classe_id.in_(ids), Inscription.annee_scolaire_id == annee.id,
                       Eleve.etablissement_id == etab_id))
    lignes = []
    for inscription, eleve, parent in requete.all():
        ligne = {
            "id": inscription.id,
            "classe_id": inscription.classe_id,
            "annee_scolaire_id": inscription.annee_scolaire_id,
            "date_inscription": inscription.date_inscription.isoformat() if inscription.date_inscription else None,
            "statut": inscription.statut or "Actif",
            "eleve_id": eleve.id,
            "matricule": eleve.matricule,
            "nom": eleve.nom,
            "prenom": eleve.prenom,
            "sexe": eleve.sexe,
            "date_naissance": eleve.date_naissance.isoformat() if eleve.date_naissance else None,
            "lieu_naissance": eleve.lieu_naissance,
        }
        if avec_parents:
            ligne["parent_nom"] = f"{parent.nom} {parent.prenom}".strip() if parent else None
            ligne["parent_telephone"] = parent.telephone if parent else None
        lignes.append(ligne)
    return lignes, 200
