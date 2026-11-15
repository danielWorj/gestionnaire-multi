"""Suppression d'un élève / d'une inscription : message clair (409) quand ils
sont déjà liés à des notes, des fiches de discipline ou des paiements, suppression
complète (200) sinon. Régression : l'ancien comportement était un 500 muet."""
from datetime import date

from extensions import db
from models.evaluation_models import Note, Discipline
from models.inscription_models import Eleve, Inscription
from models.paiements_models import Paiement


def _ajouter_note(monde, valeur=12):
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=valeur))
    db.session.commit()


def _ajouter_discipline(monde):
    db.session.add(Discipline(inscription_id=monde.inscription_id, sequence_id=monde.sequence_id))
    db.session.commit()


def test_eleve_inscrit_sans_historique_est_supprime(monde, connecter):
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/eleves/{monde.eleve_id}')
    assert rep.status_code == 200, rep.get_json()
    assert db.session.get(Eleve, monde.eleve_id) is None
    assert Inscription.query.filter_by(eleve_id=monde.eleve_id).count() == 0


def test_eleve_sans_inscription_est_supprime(monde, connecter):
    admin = connecter(monde.admin_compte)
    db.session.delete(db.session.get(Inscription, monde.inscription_id))
    db.session.commit()
    assert admin.delete(f'/api/eleves/{monde.eleve_id}').status_code == 200


def test_eleve_avec_notes_refuse_avec_message_clair(monde, connecter):
    _ajouter_note(monde)
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/eleves/{monde.eleve_id}')
    data = rep.get_json()
    assert rep.status_code == 409, data
    assert data['code'] == 'eleve_lie'
    assert 'Un Eleve' in data['erreur'] and '1 note' in data['erreur'] and 'Inactif' in data['erreur']
    assert data['details'] == {'inscriptions': 1, 'notes': 1}
    # Rien n'a été supprimé.
    assert db.session.get(Eleve, monde.eleve_id) is not None
    assert Inscription.query.filter_by(eleve_id=monde.eleve_id).count() == 1
    assert Note.query.count() == 1


def test_eleve_avec_notes_et_discipline_les_liste_toutes(monde, connecter):
    _ajouter_note(monde, 10)
    _ajouter_discipline(monde)
    admin = connecter(monde.admin_compte)
    data = admin.delete(f'/api/eleves/{monde.eleve_id}').get_json()
    assert '1 note et 1 fiche de discipline' in data['erreur']


def test_eleve_avec_paiement_refuse(monde, connecter):
    db.session.add(Paiement(inscription_id=monde.inscription_id, parent_id=monde.parent_id,
                            encaisse_par_id=monde.admin_compte['id'], numero_recu='R-0001',
                            montant_total=5000, mode_paiement='ESPECES'))
    db.session.commit()
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/eleves/{monde.eleve_id}')
    assert rep.status_code == 409
    assert '1 paiement' in rep.get_json()['erreur']
    assert db.session.get(Eleve, monde.eleve_id) is not None


def test_inscription_avec_notes_refusee(monde, connecter):
    _ajouter_note(monde)
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/inscriptions/{monde.inscription_id}')
    data = rep.get_json()
    assert rep.status_code == 409, data
    assert data['code'] == 'inscription_liee'
    assert '1 note' in data['erreur'] and 'Radié' in data['erreur']
    assert db.session.get(Inscription, monde.inscription_id) is not None


def test_inscription_sans_historique_est_retiree_et_l_eleve_reste(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert admin.delete(f'/api/inscriptions/{monde.inscription_id}').status_code == 200
    assert db.session.get(Eleve, monde.eleve_id) is not None


def test_contrainte_de_cle_etrangere_donne_409_et_non_500(monde, connecter):
    """Filet de sécurité générique (delete_entity) : un élément encore utilisé
    ailleurs (ici un parent qui a des enfants) renvoie 409, jamais 500."""
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/parents/{monde.parent_id}')
    assert rep.status_code == 409, rep.get_json()
    assert 'encore utilisé' in rep.get_json()['erreur']
