"""Changement de classe d'un élève depuis la fiche (page Élèves) : Admin,
Secrétaire et Censeur (limité à ses classes assignées) ; inscription d'un élève
qui n'avait pas d'inscription cette année."""
from datetime import date

from extensions import db
from models.authentification_models import Role
from models.inscription_models import Eleve, Inscription
from models.pedagogie_models import Censeur, CenseurClasse
from models.structure_models import Classe, Cycle
from services.authentification_services import create_utilisateur


def _classe(monde, libelle='6e B'):
    cycle = Cycle(etablissement_id=monde.etab_id, libelle=libelle)
    db.session.add(cycle)
    db.session.flush()
    classe = Classe(etablissement_id=monde.etab_id, cycle_id=cycle.id)
    db.session.add(classe)
    db.session.commit()
    return classe.id


def _secretaire(monde):
    role = Role.query.filter_by(libelle='Secretaire').first()
    res, status = create_utilisateur({'nom': 'Secretaire Test', 'role_ids': [role.id], 'etablissement_id': monde.etab_id})
    assert status == 201, res
    return res


def _eleve_sans_inscription(monde):
    eleve = Eleve(etablissement_id=monde.etab_id, matricule='M002', nom='Sans', prenom='Classe', sexe='M',
                  lieu_naissance='Douala', parent_id=monde.parent_id)
    db.session.add(eleve)
    db.session.commit()
    return eleve.id


def test_admin_change_la_classe_de_l_eleve(monde, connecter):
    autre = _classe(monde)
    admin = connecter(monde.admin_compte)
    rep = admin.put(f'/api/inscriptions/{monde.inscription_id}', json={'classe_id': autre})
    assert rep.status_code == 200, rep.get_json()
    assert db.session.get(Inscription, monde.inscription_id).classe_id == autre
    # Toujours une seule inscription pour l'année.
    assert Inscription.query.filter_by(eleve_id=monde.eleve_id, annee_scolaire_id=monde.annee_id).count() == 1


def test_secretaire_change_la_classe_de_l_eleve(monde, connecter):
    autre = _classe(monde)
    secretaire = connecter(_secretaire(monde))
    rep = secretaire.put(f'/api/inscriptions/{monde.inscription_id}', json={'classe_id': autre})
    assert rep.status_code == 200, rep.get_json()
    assert db.session.get(Inscription, monde.inscription_id).classe_id == autre


def test_admin_inscrit_un_eleve_sans_inscription(monde, connecter):
    eleve_id = _eleve_sans_inscription(monde)
    admin = connecter(monde.admin_compte)
    rep = admin.post('/api/inscriptions/', json={
        'eleve_id': eleve_id, 'classe_id': monde.classe_id, 'annee_scolaire_id': monde.annee_id,
        'date_inscription': date(2026, 11, 15).isoformat(), 'statut': 'Actif'})
    assert rep.status_code == 201, rep.get_json()
    assert Inscription.query.filter_by(eleve_id=eleve_id).count() == 1


def test_inscrire_un_eleve_deja_inscrit_est_refuse(monde, connecter):
    admin = connecter(monde.admin_compte)
    rep = admin.post('/api/inscriptions/', json={
        'eleve_id': monde.eleve_id, 'classe_id': monde.classe_id, 'annee_scolaire_id': monde.annee_id,
        'date_inscription': date(2026, 11, 15).isoformat()})
    assert rep.status_code == 409


def test_censeur_lit_les_eleves_et_parents(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    assert censeur.get('/api/eleves/').status_code == 200
    assert censeur.get('/api/parents/').status_code == 200
    # Lecture seule sur ces deux ressources.
    assert censeur.put(f'/api/eleves/{monde.eleve_id}', json={'nom': 'X'}).status_code == 403
    assert censeur.delete(f'/api/eleves/{monde.eleve_id}').status_code == 403


def test_censeur_change_la_classe_entre_ses_classes(monde, connecter):
    autre = _classe(monde)
    censeur_id = Censeur.query.first().id
    db.session.add(CenseurClasse(censeur_id=censeur_id, classe_id=autre))
    db.session.commit()
    censeur = connecter(monde.censeur_compte)
    rep = censeur.put(f'/api/inscriptions/{monde.inscription_id}', json={'classe_id': autre})
    assert rep.status_code == 200, rep.get_json()
    assert db.session.get(Inscription, monde.inscription_id).classe_id == autre


def test_censeur_ne_peut_pas_viser_une_classe_non_assignee(monde, connecter):
    autre = _classe(monde)  # non assignée au censeur
    censeur = connecter(monde.censeur_compte)
    rep = censeur.put(f'/api/inscriptions/{monde.inscription_id}', json={'classe_id': autre})
    assert rep.status_code == 403, rep.get_json()
    assert db.session.get(Inscription, monde.inscription_id).classe_id == monde.classe_id


def test_censeur_inscrit_dans_sa_classe_mais_pas_ailleurs(monde, connecter):
    eleve_id = _eleve_sans_inscription(monde)
    autre = _classe(monde)
    censeur = connecter(monde.censeur_compte)
    corps = {'eleve_id': eleve_id, 'annee_scolaire_id': monde.annee_id, 'date_inscription': '2026-11-15'}
    assert censeur.post('/api/inscriptions/', json={**corps, 'classe_id': autre}).status_code == 403
    rep = censeur.post('/api/inscriptions/', json={**corps, 'classe_id': monde.classe_id, 'statut': 'Radié'})
    assert rep.status_code == 201, rep.get_json()
    # Le statut demandé est ignoré : l'inscription est toujours créée « Actif ».
    assert Inscription.query.filter_by(eleve_id=eleve_id).one().statut == 'Actif'


def test_censeur_ne_peut_ni_radier_ni_supprimer_une_inscription(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    rep = censeur.put(f'/api/inscriptions/{monde.inscription_id}', json={'statut': 'Radié'})
    assert rep.status_code == 200
    assert db.session.get(Inscription, monde.inscription_id).statut == 'Actif'
    assert censeur.delete(f'/api/inscriptions/{monde.inscription_id}').status_code == 403


def test_surveillant_reste_en_lecture_seule(monde, connecter):
    role = Role.query.filter_by(libelle='Surveillant').first()
    res, status = create_utilisateur({'nom': 'Surv Test', 'role_ids': [role.id], 'etablissement_id': monde.etab_id})
    assert status == 201, res
    surveillant = connecter(res)
    autre = _classe(monde)
    assert surveillant.put(f'/api/inscriptions/{monde.inscription_id}', json={'classe_id': autre}).status_code == 403
    assert surveillant.get('/api/eleves/').status_code == 403
