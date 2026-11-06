"""Socle des tests : application sur SQLite en mémoire, un établissement
complet (classe, année, séquence, matière-classe, élève inscrit…) et des
comptes connectés par la vraie route /api/auth/login (cookies JWT + CSRF).

Lancer : cd server && python -m pytest -q
"""
import sys
from datetime import date
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parent.parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from app import create_app  # noqa: E402
from extensions import db  # noqa: E402


# « appli » et non « app » : pytest-flask (s'il est installé) ouvrirait sinon
# un contexte de requête factice pour chaque test, ce qui fausse l'auteur des
# écritures faites hors requête (scripts, CLI).
@pytest.fixture()
def appli():
    application = create_app('testing')
    with application.app_context():
        db.create_all()
        yield application
        db.session.remove()
        db.drop_all()


class Monde:
    """Identifiants des données de test (accès par attribut)."""


@pytest.fixture()
def monde(appli):
    from models.authentification_models import Role
    from models.structure_models import Etablissement, Cycle, Classe, AnneeScolaire, Trimestre, Sequence
    from models.pedagogie_models import GroupeMatiere, Matiere, Departement, Grade, Enseignant, MatiereClasse, Censeur, CenseurClasse
    from models.inscription_models import Parent, Eleve, Inscription
    from services.authentification_services import create_utilisateur

    Role.init_roles()
    m = Monde()

    etab = Etablissement(code='TST1', nom='Lycée de test')
    db.session.add(etab)
    db.session.flush()
    cycle = Cycle(etablissement_id=etab.id, libelle='6e')
    db.session.add(cycle)
    db.session.flush()
    classe = Classe(etablissement_id=etab.id, cycle_id=cycle.id)
    annee = AnneeScolaire(etablissement_id=etab.id, libelle='2026-2027', active=True)
    db.session.add_all([classe, annee])
    db.session.flush()
    trimestre = Trimestre(annee_scolaire_id=annee.id, libelle='T1')
    db.session.add(trimestre)
    db.session.flush()
    sequence = Sequence(trimestre_id=trimestre.id, libelle='Seq1')
    groupe = GroupeMatiere(etablissement_id=etab.id, libelle='Sciences')
    departement = Departement(etablissement_id=etab.id, libelle='Maths')
    grade = Grade(etablissement_id=etab.id, libelle='PLEG')
    db.session.add_all([sequence, groupe, departement, grade])
    db.session.flush()
    matiere = Matiere(etablissement_id=etab.id, libelle='Mathématiques', groupe_id=groupe.id)
    db.session.add(matiere)
    db.session.commit()

    roles = {r.libelle: r.id for r in Role.query.all()}

    def compte(nom, role):
        res, status = create_utilisateur({'nom': nom, 'role_ids': [roles[role]], 'etablissement_id': etab.id})
        assert status == 201, res
        return res

    m.enseignant_compte = compte('Prof Test', 'Enseignant')
    m.admin_compte = compte('Admin Test', 'Admin')
    m.censeur_compte = compte('Censeur Test', 'Censeur')

    enseignant = Enseignant(etablissement_id=etab.id, nom='Prof', prenom='Test', departement_id=departement.id,
                            grade_id=grade.id, utilisateur_id=m.enseignant_compte['id'])
    db.session.add(enseignant)
    db.session.flush()
    censeur = Censeur(etablissement_id=etab.id, nom='Censeur', prenom='Test', utilisateur_id=m.censeur_compte['id'])
    db.session.add(censeur)
    db.session.flush()
    db.session.add(CenseurClasse(censeur_id=censeur.id, classe_id=classe.id))
    mc = MatiereClasse(classe_id=classe.id, matiere_id=matiere.id, enseignant_id=enseignant.id, coefficient=4)
    parent = Parent(etablissement_id=etab.id, nom='Parent', prenom='Un', telephone='600000000', email='p@test.cm')
    db.session.add_all([mc, parent])
    db.session.flush()
    eleve = Eleve(etablissement_id=etab.id, matricule='M001', nom='Eleve', prenom='Un', sexe='F',
                  lieu_naissance='Yaoundé', parent_id=parent.id)
    db.session.add(eleve)
    db.session.flush()
    inscription = Inscription(eleve_id=eleve.id, classe_id=classe.id, annee_scolaire_id=annee.id,
                              date_inscription=date(2026, 9, 1))
    db.session.add(inscription)
    db.session.commit()

    for nom, obj in dict(etab=etab, classe=classe, annee=annee, trimestre=trimestre, sequence=sequence,
                         matiere=matiere, enseignant=enseignant, mc=mc, parent=parent, eleve=eleve,
                         inscription=inscription).items():
        setattr(m, f'{nom}_id', obj.id)
    return m


class ClientApi:
    """Client de test connecté : ajoute le jeton CSRF aux écritures."""

    def __init__(self, client):
        self.client = client

    def _entetes(self, entetes=None):
        h = dict(entetes or {})
        cookie = self.client.get_cookie('csrf_access_token')
        if cookie:
            h['X-CSRF-TOKEN'] = cookie.value
        return h

    def get(self, url, **kw):
        return self.client.get(url, **kw)

    def post(self, url, json=None, headers=None):
        return self.client.post(url, json=json if json is not None else {}, headers=self._entetes(headers))

    def put(self, url, json=None, headers=None):
        return self.client.put(url, json=json if json is not None else {}, headers=self._entetes(headers))

    def delete(self, url, headers=None):
        return self.client.delete(url, headers=self._entetes(headers))


@pytest.fixture()
def connecter(appli):
    def _connecter(compte):
        client = appli.test_client()
        rep = client.post('/api/auth/login', json={'code': compte['code_connexion'], 'pin': compte['pin_temporaire']})
        assert rep.status_code == 200, rep.get_json()
        return ClientApi(client)
    return _connecter


@pytest.fixture()
def connecter_superadmin(appli):
    """Crée un compte SuperAdmin et le connecte (email + mot de passe)."""
    def _connecter(email='super@test.cm', nom='Super Test', mot_de_passe='Motdepasse1'):
        from models.authentification_models import SuperAdmin
        compte = SuperAdmin(nom=nom, email=email, actif=True)
        compte.set_password(mot_de_passe)
        db.session.add(compte)
        db.session.commit()
        client = appli.test_client()
        rep = client.post('/api/auth/superadmin/login', json={'email': email, 'password': mot_de_passe})
        assert rep.status_code == 200, rep.get_json()
        api = ClientApi(client)
        api.id = compte.id
        return api
    return _connecter
