"""Suppression d'une classe : directe si elle est vide ; sinon 409 détaillé, puis
suppression en cascade (?cascade=1, Admin) de tout ce qui s'y rattache. Les
élèves eux-mêmes sont conservés : seule leur inscription dans la classe part."""
from extensions import db
from models.evaluation_models import Note, Discipline
from models.inscription_models import Eleve, Inscription
from models.pedagogie_models import MatiereClasse, CenseurClasse
from models.structure_models import Classe, Cycle


def _classe_vide(monde):
    cycle = Cycle(etablissement_id=monde.etab_id, libelle='5e')
    db.session.add(cycle)
    db.session.flush()
    classe = Classe(etablissement_id=monde.etab_id, cycle_id=cycle.id, option='Z')
    db.session.add(classe)
    db.session.commit()
    return classe.id


def _donnees(monde):
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=12))
    db.session.add(Discipline(inscription_id=monde.inscription_id, sequence_id=monde.sequence_id))
    db.session.commit()


def test_classe_vide_supprimee_directement(monde, connecter):
    cid = _classe_vide(monde)
    admin = connecter(monde.admin_compte)
    assert admin.get(f'/api/classes/{cid}/liens').get_json()['liens'] == {}
    rep = admin.delete(f'/api/classes/{cid}')
    assert rep.status_code == 200, rep.get_json()
    assert db.session.get(Classe, cid) is None


def test_classe_liee_refusee_sans_cascade_avec_details(monde, connecter):
    _donnees(monde)
    admin = connecter(monde.admin_compte)
    liens = admin.get(f'/api/classes/{monde.classe_id}/liens').get_json()['liens']
    assert liens['inscriptions'] == 1 and liens['notes'] == 1 and liens['disciplines'] == 1
    assert liens['matieres'] == 1 and liens['censeurs'] == 1
    rep = admin.delete(f'/api/classes/{monde.classe_id}')
    data = rep.get_json()
    assert rep.status_code == 409 and data['code'] == 'classe_liee', data
    assert data['details'] == liens
    # Rien n'a été supprimé.
    assert db.session.get(Classe, monde.classe_id) is not None
    assert Note.query.count() == 1 and Inscription.query.count() == 1


def test_cascade_supprime_tout_sauf_l_eleve(monde, connecter):
    _donnees(monde)
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/classes/{monde.classe_id}?cascade=1')
    assert rep.status_code == 200, rep.get_json()
    assert db.session.get(Classe, monde.classe_id) is None
    assert Inscription.query.count() == 0
    assert Note.query.count() == 0 and Discipline.query.count() == 0
    assert MatiereClasse.query.count() == 0 and CenseurClasse.query.count() == 0
    # Le dossier de l'élève est conservé.
    assert db.session.get(Eleve, monde.eleve_id) is not None


def test_cascade_refusee_au_censeur(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    assert censeur.delete(f'/api/classes/{monde.classe_id}?cascade=1').status_code == 403
    assert censeur.get(f'/api/classes/{monde.classe_id}/liens').status_code == 403
    assert db.session.get(Classe, monde.classe_id) is not None
