"""Doublons à l'intérieur des fichiers importés : par défaut, seule la
première occurrence est importée, les copies passent au statut « doublon »
et rien n'est écrit pour elles."""

import pytest

from extensions import db
from models.inscription_models import Eleve, Inscription
from models.pedagogie_models import Enseignant


@pytest.fixture()
def admin(monde, connecter):
    return connecter(monde.admin_compte)


def _bloc(entetes, lignes, source='liste.xlsx'):
    return {'source': source, 'entetes': entetes, 'lignes': lignes}


ENTETES_ELEVES = ['Matricule', 'Nom', 'Prénom', 'Sexe', 'Lieu de naissance']


def test_eleves_doublon_ignore_par_defaut(monde, admin):
    bloc = _bloc(ENTETES_ELEVES, [
        ['M100', 'ATANGANA', 'Paul', 'M', 'Yaoundé'],
        ['M101', 'ESSOMBA', 'Marie', 'F', 'Douala'],
        ['M100', 'ATANGANA', 'Paul', 'M', 'Yaoundé'],      # copie exacte
        ['M001', 'Eleve', 'Un', 'F', 'Yaoundé'],           # déjà enregistré
        ['M001', 'Eleve', 'Un', 'F', 'Yaoundé'],           # déjà enregistré, en double
    ])
    options = {'parent_defaut': 'provisoire', 'inscrire': False}
    data = admin.post('/api/import/eleves/traiter', json={'blocs': [bloc], 'options': options}).get_json()
    statuts = [l['statut'] for l in data['lignes']]
    assert statuts == ['nouveau', 'nouveau', 'doublon', 'existant', 'doublon']
    assert data['resume']['doublons'] == 2 and data['resume']['erreurs'] == 0
    doublon = data['lignes'][2]
    assert doublon['erreurs'] == [] and 'non importé' in doublon['avertissements'][0]

    rep = admin.post('/api/import/eleves/traiter', json={'blocs': [bloc], 'options': options, 'valider': True})
    assert rep.status_code == 200, rep.get_json()
    assert Eleve.query.filter_by(etablissement_id=monde.etab_id, matricule='M100').count() == 1
    assert Eleve.query.filter_by(etablissement_id=monde.etab_id).count() == 3


def test_eleves_meme_matricule_autre_eleve_reste_une_erreur(monde, admin):
    bloc = _bloc(ENTETES_ELEVES, [
        ['M200', 'NGONO', 'Alice', 'F', 'Kribi'],
        ['M200', 'MBARGA', 'Jean', 'M', 'Ebolowa'],
    ])
    data = admin.post('/api/import/eleves/traiter', json={'blocs': [bloc], 'options': {'parent_defaut': 'provisoire'}}).get_json()
    assert [l['statut'] for l in data['lignes']] == ['nouveau', 'erreur']
    assert 'autre élève' in data['lignes'][1]['erreurs'][0]


def test_eleves_doublon_sans_inscription(monde, admin):
    """La copie d'un élève n'entraîne ni création ni inscription en plus."""
    bloc = _bloc(ENTETES_ELEVES + ['Classe'], [
        ['M300', 'OWONA', 'Luc', 'M', 'Mbalmayo', '6e'],
        ['M300', 'OWONA', 'Luc', 'M', 'Mbalmayo', '6e'],
    ])
    options = {'parent_defaut': 'provisoire', 'inscrire': True, 'annee_scolaire_id': monde.annee_id,
               'classe_fixe': monde.classe_id}
    data = admin.post('/api/import/eleves/traiter', json={'blocs': [bloc], 'options': options, 'valider': True}).get_json()
    assert data['resume']['doublons'] == 1
    eleve = Eleve.query.filter_by(etablissement_id=monde.etab_id, matricule='M300').one()
    assert Inscription.query.filter_by(eleve_id=eleve.id).count() <= 1


def test_enseignants_doublon_ignore(monde, admin):
    bloc = _bloc(['Nom', 'Prénom', 'Sexe', 'Téléphone', 'Département', 'Grade'], [
        ['FOUDA', 'Henri', 'M', '677000001', 'Maths', 'PLEG'],
        ['FOUDA', 'Henri', 'M', '677000001', 'Maths', 'PLEG'],
    ])
    options = {'creer_comptes': False}
    data = admin.post('/api/import/enseignants/traiter', json={'blocs': [bloc], 'options': options, 'valider': True}).get_json()
    assert [l['statut'] for l in data['lignes']] == ['nouveau', 'doublon']
    assert data['resume']['doublons'] == 1
    db.session.expire_all()
    assert Enseignant.query.filter_by(etablissement_id=monde.etab_id, nom='FOUDA').count() == 1


def test_tresorerie_lignes_identiques_non_importees_par_defaut(monde, admin):
    bloc = _bloc(['Date', 'Libellé', 'Rubrique', 'Recettes', 'Dépenses'], [
        ['01/10/2026', 'Don de la mairie', 'Dons', '200000', ''],
        ['01/10/2026', 'Don de la mairie', 'Dons', '200000', ''],
    ], source='cahier.xlsx')
    data = admin.post('/api/import/tresorerie/traiter', json={'blocs': [bloc]}).get_json()
    assert [l['statut'] for l in data['lignes']] == ['nouveau', 'doublon']
    assert data['resume']['doublons'] == 1 and data['resume']['total_entrees'] == 200000

    # Option explicite : les deux lignes sont importées.
    data = admin.post('/api/import/tresorerie/traiter',
                      json={'blocs': [bloc], 'options': {'importer_doublons': True}}).get_json()
    assert [l['statut'] for l in data['lignes']] == ['nouveau', 'nouveau']

    # La première ligne exclue : sa copie redevient importable.
    premiere = data['lignes'][0]['id']
    data = admin.post('/api/import/tresorerie/traiter', json={'blocs': [bloc], 'exclues': [premiere]}).get_json()
    assert [l['statut'] for l in data['lignes']] == ['exclu', 'nouveau']
