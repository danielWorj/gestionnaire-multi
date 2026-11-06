"""Dossier d'inscription (parent + élève + inscription en une transaction) :
doublons, écrasement, atomicité ; conflits sur les fiches élève / parent."""
from extensions import db
from models.audit_models import JournalAudit
from models.inscription_models import Eleve, Inscription, Parent
from models.structure_models import Classe

URL = '/api/dossiers-inscription/'


def _dossier(monde, **kw):
    d = {
        'parent': {'nom': 'Mballa', 'prenom': 'Jean', 'telephone': '677000000', 'email': 'mballa@test.cm'},
        'eleve': {'matricule': 'M100', 'nom': 'Mballa', 'prenom': 'Paul', 'sexe': 'M',
                  'date_naissance': '2014-05-02', 'lieu_naissance': 'Douala'},
        'inscription': {'classe_id': monde.classe_id, 'annee_scolaire_id': monde.annee_id,
                        'date_inscription': '2026-09-05', 'statut': 'Actif'},
    }
    d.update(kw)
    return d


def _autre_classe(monde):
    classe = Classe(etablissement_id=monde.etab_id, cycle_id=db.session.get(Classe, monde.classe_id).cycle_id, option='B')
    db.session.add(classe)
    db.session.commit()
    return classe.id


def test_dossier_complet_en_une_transaction(monde, connecter):
    admin = connecter(monde.admin_compte)
    rep = admin.post(URL, json=_dossier(monde))
    assert rep.status_code == 201, rep.get_json()
    data = rep.get_json()
    assert data['eleve']['parent_id'] == data['parent']['id']
    assert data['inscription']['eleve_id'] == data['eleve']['id']
    assert data['inscription']['classe_label']
    for table in ('parent', 'eleve', 'inscription'):
        entree = JournalAudit.query.filter_by(table_nom=table, action='creation').order_by(JournalAudit.id.desc()).first()
        assert entree.auteur_nom == 'Admin Test'


def test_renvoi_identique_reutilise_sans_doublon(monde, connecter):
    admin = connecter(monde.admin_compte)
    premier = admin.post(URL, json=_dossier(monde)).get_json()
    rep = admin.post(URL, json=_dossier(monde))
    assert rep.status_code == 201
    assert rep.get_json()['inscription']['id'] == premier['inscription']['id']
    assert Eleve.query.filter_by(matricule='M100').count() == 1


def test_parent_doublon_rien_n_est_ecrit(monde, connecter):
    admin = connecter(monde.admin_compte)
    nb_eleves = Eleve.query.count()
    d = _dossier(monde, parent={'nom': 'Parent', 'prenom': 'Autre', 'telephone': '699', 'email': 'p@test.cm'})
    rep = admin.post(URL, json=d)
    assert rep.status_code == 409
    data = rep.get_json()
    assert data['code'] == 'doublon'
    assert [x['type'] for x in data['doublons']] == ['parent']
    assert data['serveur']['parent']['telephone'] == '600000000'
    assert Eleve.query.count() == nb_eleves

    # Écraser : le parent existant prend les valeurs saisies, le dossier passe.
    rep = admin.post(URL, json={**d, 'forcer': True})
    assert rep.status_code == 201, rep.get_json()
    assert rep.get_json()['parent']['id'] == monde.parent_id
    assert db.session.get(Parent, monde.parent_id).telephone == '699'


def test_eleve_deja_inscrit_cette_annee(monde, connecter):
    admin = connecter(monde.admin_compte)
    autre = _autre_classe(monde)
    d = {'eleve_id': monde.eleve_id,
         'inscription': {'classe_id': autre, 'annee_scolaire_id': monde.annee_id, 'date_inscription': '2026-10-01'}}
    rep = admin.post(URL, json=d)
    assert rep.status_code == 409
    data = rep.get_json()
    assert [x['type'] for x in data['doublons']] == ['inscription']
    assert data['serveur']['inscription']['classe_id'] == monde.classe_id
    assert data['serveur']['inscription']['classe_label']

    rep = admin.post(URL, json={**d, 'forcer': True})
    assert rep.status_code == 201
    insc = db.session.get(Inscription, monde.inscription_id)
    assert insc.classe_id == autre
    assert Inscription.query.filter_by(eleve_id=monde.eleve_id).count() == 1


def test_matricule_doublon(monde, connecter):
    admin = connecter(monde.admin_compte)
    d = _dossier(monde, parent=None, parent_id=monde.parent_id,
                 eleve={'matricule': 'M001', 'nom': 'Autre', 'prenom': 'Enfant', 'sexe': 'M', 'lieu_naissance': 'Kribi'})
    rep = admin.post(URL, json=d)
    assert rep.status_code == 409
    types = [x['type'] for x in rep.get_json()['doublons']]
    assert 'eleve' in types
    assert db.session.get(Eleve, monde.eleve_id).nom == 'Eleve'


def test_erreur_annule_tout(monde, connecter):
    admin = connecter(monde.admin_compte)
    nb_parents = Parent.query.count()
    d = _dossier(monde)
    d['inscription']['classe_id'] = 99999
    rep = admin.post(URL, json=d)
    assert rep.status_code == 400
    db.session.rollback()
    assert Parent.query.count() == nb_parents
    assert Eleve.query.filter_by(matricule='M100').count() == 0


def test_dossier_refuse_a_l_enseignant(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    assert prof.post(URL, json=_dossier(monde)).status_code == 403


def test_conflit_sur_fiche_eleve(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert admin.put(f'/api/eleves/{monde.eleve_id}', json={'lieu_naissance': 'Bafoussam', 'version_base': 1}).status_code == 200
    rep = admin.put(f'/api/eleves/{monde.eleve_id}', json={'lieu_naissance': 'Garoua', 'version_base': 1})
    assert rep.status_code == 409
    assert rep.get_json()['code'] == 'conflit'
    assert rep.get_json()['serveur']['lieu_naissance'] == 'Bafoussam'
    rep = admin.put(f'/api/eleves/{monde.eleve_id}', json={'lieu_naissance': 'Garoua', 'version_base': 1, 'forcer': True})
    assert rep.status_code == 200
    assert rep.get_json()['version'] == 3


def test_conflit_sur_inscription(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert admin.put(f'/api/inscriptions/{monde.inscription_id}', json={'statut': 'Suspendu', 'version_base': 1}).status_code == 200
    rep = admin.put(f'/api/inscriptions/{monde.inscription_id}', json={'statut': 'Radié', 'version_base': 1})
    assert rep.status_code == 409
