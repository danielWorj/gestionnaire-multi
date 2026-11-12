"""Gestion de l'accès des familles à l'espace parent, par le secrétariat et
l'administration (page Parents) :

- un compte de connexion PAR PARENT (et non par élève) : le parent voit
  tous ses enfants avec le même code + PIN. Si la personne a déjà un compte
  dans l'établissement (même e-mail, ex. un enseignant qui est aussi parent),
  le rôle Parent est AJOUTÉ à ce compte : elle garde son code et son PIN et
  choisit son espace à la connexion (multi-rôles) ;
- rattachement d'un enfant à sa famille ;
- levée du blocage du bulletin d'un élève (Admin uniquement).

Un compte qui ne sert qu'à l'espace parent est entièrement géré ici (PIN,
suspension). Un compte qui sert aussi au personnel ne l'est pas : seul son
rôle Parent est ajouté ou retiré, son PIN se gère depuis les comptes du
personnel.
"""
from sqlalchemy.exc import IntegrityError

from extensions import db
from models.authentification_models import Role, SessionConnexion, Utilisateur, generate_temp_pin
from models.inscription_models import Eleve, Inscription, Parent
from services.authentification_services import reset_temp_password
from services.notification_services import invalider_generation

ROLE_PARENT = 'Parent'


def _role_parent():
    return Role.get_or_create(ROLE_PARENT)


def _nom_compte(parent):
    return f"{parent.prenom or ''} {parent.nom or ''}".strip() or parent.nom


def _est_compte_parent_seul(utilisateur):
    return utilisateur.libelles_roles() == [ROLE_PARENT]


def etat_acces(parent):
    """{existe, actif, code_connexion, dernier_login, verrouille, autres_roles}."""
    u = parent.utilisateur
    if u is None:
        return {"existe": False, "actif": False, "code_connexion": None, "dernier_login": None,
                "verrouille": False, "autres_roles": []}
    return {
        "existe": True,
        "actif": bool(u.actif and u.a_role(ROLE_PARENT)),
        "code_connexion": u.code_connexion,
        "dernier_login": u.dernier_login.isoformat() + 'Z' if u.dernier_login else None,
        "verrouille": u.est_verrouille(),
        "autres_roles": [r for r in u.libelles_roles() if r != ROLE_PARENT],
    }


def _reponse(parent, pin=None, compte_existant=False):
    data = {"parent_id": parent.id, "nom": _nom_compte(parent), **etat_acces(parent)}
    if pin:
        # Communiqué UNE SEULE FOIS (hash bcrypt non réversible).
        data["pin"] = pin
    data["compte_existant"] = compte_existant
    return data


def ouvrir_acces(parent):
    """Crée (ou rouvre) l'accès du parent à l'espace parent.

    - Aucun compte : nouveau compte (rôle Parent), code + PIN renvoyés une
      seule fois — ou, si un compte de l'établissement porte déjà l'e-mail du
      parent, rôle Parent ajouté à ce compte (pas de PIN : il garde le sien).
    - Compte existant dont l'accès a été retiré : rôle Parent rendu ; un
      compte « parent seul » reçoit un nouveau PIN (l'ancien n'est plus connu).
    - Accès déjà ouvert : 409 (utiliser nouveau_pin)."""
    role = _role_parent()
    try:
        u = parent.utilisateur
        if u is not None:
            if u.actif and u.a_role(ROLE_PARENT):
                return {"erreur": "Cette famille a déjà un accès ouvert. Générez un nouveau PIN si elle l'a perdu."}, 409
            if role not in u.roles:
                u.roles.append(role)
            pin = None
            if _est_compte_parent_seul(u):
                u.actif = True
                pin = generate_temp_pin()
                u.set_password(pin)
                u.deverrouiller()
                SessionConnexion.fermer_toutes('utilisateur', u.id)
            db.session.commit()
            invalider_generation(parent.etablissement_id)
            return _reponse(parent, pin=pin, compte_existant=pin is None), 200

        existant = Utilisateur.query.filter_by(etablissement_id=parent.etablissement_id, email=parent.email).first() \
            if parent.email else None
        if existant is not None:
            if Parent.query.filter(Parent.utilisateur_id == existant.id, Parent.id != parent.id).first():
                return {"erreur": "Le compte portant cet e-mail est déjà relié à une autre famille"}, 409
            if role not in existant.roles:
                existant.roles.append(role)
            parent.utilisateur_id = existant.id
            db.session.commit()
            invalider_generation(parent.etablissement_id)
            return _reponse(parent, compte_existant=True), 200

        pin = generate_temp_pin()
        u = Utilisateur(nom=_nom_compte(parent), email=parent.email or None, roles=[role],
                        etablissement_id=parent.etablissement_id, actif=True, doit_changer_mdp=False)
        u.set_password(pin)
        db.session.add(u)
        db.session.flush()
        parent.utilisateur_id = u.id
        db.session.commit()
        invalider_generation(parent.etablissement_id)
        return _reponse(parent, pin=pin), 201
    except IntegrityError:
        db.session.rollback()
        return {"erreur": "Ce compte est déjà relié à une autre famille"}, 409


def nouveau_pin(parent):
    """Nouveau PIN (oubli, compte bloqué). Réservé aux comptes « parent
    seul » : le PIN d'un membre du personnel ne se change pas d'ici."""
    u = parent.utilisateur
    if u is None or not (u.actif and u.a_role(ROLE_PARENT)):
        return {"erreur": "Cette famille n'a pas d'accès ouvert"}, 409
    if not _est_compte_parent_seul(u):
        return {"erreur": "Ce compte sert aussi au personnel de l'établissement : son PIN se réinitialise "
                          "depuis la gestion des comptes du personnel."}, 409
    resultat, status = reset_temp_password(u.id)
    if status != 200:
        return resultat, status
    return _reponse(parent, pin=resultat['pin_temporaire']), 200


def retirer_acces(parent):
    """Retire le rôle Parent du compte. Un compte « parent seul » est en plus
    désactivé et déconnecté de tous ses appareils ; il reste relié à la
    famille, qui retrouvera le même code si l'accès est rouvert."""
    u = parent.utilisateur
    if u is None or not u.a_role(ROLE_PARENT):
        return {"erreur": "Cette famille n'a pas d'accès ouvert"}, 409
    if _est_compte_parent_seul(u):
        u.actif = False
        SessionConnexion.fermer_toutes('utilisateur', u.id)
    else:
        u.roles = [r for r in u.roles if r.libelle != ROLE_PARENT]
    db.session.commit()
    return _reponse(parent), 200


def rattacher_enfant(parent, eleve_id):
    """Rattache un élève de l'établissement à cette famille (il quitte, le cas
    échéant, la famille à laquelle il était rattaché : un élève a un seul
    parent référent)."""
    eleve = db.session.get(Eleve, eleve_id) if eleve_id else None
    if not eleve or eleve.etablissement_id != parent.etablissement_id:
        return {"erreur": "Élève introuvable dans cet établissement"}, 404
    if eleve.parent_id == parent.id:
        return {"erreur": "Cet élève est déjà rattaché à cette famille"}, 409
    eleve.parent_id = parent.id
    db.session.commit()
    invalider_generation(parent.etablissement_id)
    return eleve.to_dict(), 200


def debloquer_bulletin(parent, inscription_id, debloque):
    """Lève (ou rétablit) le blocage du bulletin d'un enfant de la famille."""
    insc = db.session.get(Inscription, inscription_id) if inscription_id else None
    if (not insc or insc.eleve is None or insc.eleve.parent_id != parent.id
            or insc.classe.etablissement_id != parent.etablissement_id):
        return {"erreur": "Inscription introuvable pour cette famille"}, 404
    insc.bulletin_debloque = bool(debloque)
    db.session.commit()
    return insc.to_dict(), 200
