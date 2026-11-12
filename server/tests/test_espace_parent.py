"""Espace parent : accès des familles (un compte par parent), rattachement des
enfants, cloisonnement, bulletin grisé si une échéance passée reste impayée
(et levée du blocage par l'administration), bulletins des seules périodes
terminées."""
from datetime import date, timedelta

import pytest

from extensions import db
from models.authentification_models import Role, Utilisateur
from models.inscription_models import Eleve, Inscription, Parent
from models.paiements_models import TrancheClasse
from models.structure_models import Sequence
from services.authentification_services import create_utilisateur

AUJ = date.today()


@pytest.fixture()
def admin(monde, connecter):
    return connecter(monde.admin_compte)


@pytest.fixture()
def secretaire(monde, connecter):
    role = Role.query.filter_by(libelle='Secretaire').first()
    compte, status = create_utilisateur({'nom': 'Secrétaire', 'role_ids': [role.id], 'etablissement_id': monde.etab_id})
    assert status == 201
    return connecter(compte)


def _ouvrir_acces(api, monde, parent_id=None):
    rep = api.post(f'/api/parents/{parent_id or monde.parent_id}/acces')
    assert rep.status_code == 201, rep.get_json()
    data = rep.get_json()
    return {'code_connexion': data['code_connexion'], 'pin_temporaire': data['pin']}


def _sequence_terminee(monde):
    seq = db.session.get(Sequence, monde.sequence_id)
    seq.date_debut = AUJ - timedelta(days=40)
    seq.date_fin = AUJ - timedelta(days=1)
    db.session.commit()


def _tranche(monde, date_limite, montant=50000):
    t = TrancheClasse(classe_id=monde.classe_id, annee_scolaire_id=monde.annee_id, libelle='T1', ordre=1,
                      montant_attendu=montant, date_limite=date_limite)
    db.session.add(t)
    db.session.commit()
    return t.id


def _autre_famille(monde, matricule='M999'):
    p = Parent(etablissement_id=monde.etab_id, nom='Autre', prenom='Famille', telephone='611111111', email='a@test.cm')
    db.session.add(p)
    db.session.flush()
    e = Eleve(etablissement_id=monde.etab_id, matricule=matricule, nom='Autre', prenom='Enfant', sexe='M',
              lieu_naissance='Douala', parent_id=p.id)
    db.session.add(e)
    db.session.commit()
    return p.id, e.id


# ---------------------------------------------------------------------------
# Accès
# ---------------------------------------------------------------------------

def test_secretariat_ouvre_l_acces_et_le_parent_voit_ses_enfants(monde, secretaire, connecter):
    parent = connecter(_ouvrir_acces(secretaire, monde))
    rep = parent.get('/api/parent/mon-espace')
    assert rep.status_code == 200, rep.get_json()
    data = rep.get_json()
    assert [e['eleve']['id'] for e in data['enfants']] == [monde.eleve_id]
    assert data['enfants'][0]['inscription']['id'] == monde.inscription_id
    assert db.session.get(Parent, monde.parent_id).utilisateur.libelles_roles() == ['Parent']


def test_acces_deja_ouvert_puis_nouveau_pin_puis_retrait(monde, secretaire, connecter, appli):
    identifiants = _ouvrir_acces(secretaire, monde)
    assert secretaire.post(f'/api/parents/{monde.parent_id}/acces').status_code == 409

    rep = secretaire.post(f'/api/parents/{monde.parent_id}/acces/nouveau-pin')
    assert rep.status_code == 200
    nouveau = {'code_connexion': identifiants['code_connexion'], 'pin_temporaire': rep.get_json()['pin']}
    client = appli.test_client()
    assert client.post('/api/auth/login', json={'code': identifiants['code_connexion'],
                                                'pin': identifiants['pin_temporaire']}).status_code == 401
    connecter(nouveau)

    assert secretaire.delete(f'/api/parents/{monde.parent_id}/acces').status_code == 200
    rep = client.post('/api/auth/login', json={'code': nouveau['code_connexion'], 'pin': nouveau['pin_temporaire']})
    assert rep.status_code == 403  # compte désactivé

    # Réouverture : même code, nouveau PIN.
    rep = secretaire.post(f'/api/parents/{monde.parent_id}/acces')
    assert rep.status_code == 200 and rep.get_json()['code_connexion'] == identifiants['code_connexion']
    connecter({'code_connexion': identifiants['code_connexion'], 'pin_temporaire': rep.get_json()['pin']})


def test_parent_deja_membre_du_personnel_garde_son_compte(monde, admin):
    prof = db.session.get(Utilisateur, monde.enseignant_compte['id'])
    prof.email = 'p@test.cm'  # même e-mail que la fiche parent
    db.session.commit()
    rep = admin.post(f'/api/parents/{monde.parent_id}/acces')
    assert rep.status_code == 200
    data = rep.get_json()
    assert data['compte_existant'] is True and 'pin' not in data
    assert data['code_connexion'] == monde.enseignant_compte['code_connexion']
    assert sorted(db.session.get(Utilisateur, prof.id).libelles_roles()) == ['Enseignant', 'Parent']
    # Son PIN ne se gère pas depuis la page Parents.
    assert admin.post(f'/api/parents/{monde.parent_id}/acces/nouveau-pin').status_code == 409
    # Retirer l'accès lui retire le rôle Parent, sans désactiver son compte.
    assert admin.delete(f'/api/parents/{monde.parent_id}/acces').status_code == 200
    prof = db.session.get(Utilisateur, prof.id)
    assert prof.actif and prof.libelles_roles() == ['Enseignant']


def test_gestion_des_acces_interdite_aux_autres_roles(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    assert prof.post(f'/api/parents/{monde.parent_id}/acces').status_code == 403
    assert prof.get(f'/api/parents/{monde.parent_id}/suivi').status_code == 403


def test_crud_generique_ne_peut_ni_relier_un_compte_ni_debloquer(monde, secretaire):
    rep = secretaire.put(f'/api/parents/{monde.parent_id}', json={'utilisateur_id': monde.admin_compte['id']})
    assert rep.status_code == 200
    assert db.session.get(Parent, monde.parent_id).utilisateur_id is None
    rep = secretaire.put(f'/api/inscriptions/{monde.inscription_id}', json={'bulletin_debloque': True})
    assert rep.status_code == 200
    assert db.session.get(Inscription, monde.inscription_id).bulletin_debloque is False


# ---------------------------------------------------------------------------
# Rattachement et cloisonnement
# ---------------------------------------------------------------------------

def test_rattacher_un_enfant(monde, secretaire, connecter):
    _, eleve_id = _autre_famille(monde)
    parent = connecter(_ouvrir_acces(secretaire, monde))
    rep = secretaire.post(f'/api/parents/{monde.parent_id}/enfants', json={'eleve_id': eleve_id})
    assert rep.status_code == 200
    assert db.session.get(Eleve, eleve_id).parent_id == monde.parent_id
    assert secretaire.post(f'/api/parents/{monde.parent_id}/enfants', json={'eleve_id': eleve_id}).status_code == 409
    ids = {e['eleve']['id'] for e in parent.get('/api/parent/mon-espace').get_json()['enfants']}
    assert ids == {monde.eleve_id, eleve_id}


def test_parent_ne_voit_jamais_l_enfant_d_une_autre_famille(monde, secretaire, connecter):
    _sequence_terminee(monde)
    _, autre_eleve = _autre_famille(monde)
    parent = connecter(_ouvrir_acces(secretaire, monde))
    assert parent.get(f'/api/parent/enfants/{autre_eleve}/photo').status_code == 404
    assert parent.get(f'/api/parent/enfants/{autre_eleve}/bulletin',
                      query_string={'periode': f'seq:{monde.sequence_id}'}).status_code == 404
    # Ni les routes du personnel.
    assert parent.get('/api/eleves/').status_code == 403
    assert parent.get('/api/bulletins/periodes', query_string={'annee_scolaire_id': monde.annee_id}).status_code == 403


# ---------------------------------------------------------------------------
# Bulletin
# ---------------------------------------------------------------------------

def _bulletin(parent, monde):
    return parent.get(f'/api/parent/enfants/{monde.eleve_id}/bulletin',
                      query_string={'periode': f'seq:{monde.sequence_id}'})


def test_bulletin_d_une_periode_en_cours_non_disponible(monde, secretaire, connecter):
    seq = db.session.get(Sequence, monde.sequence_id)
    seq.date_debut, seq.date_fin = AUJ - timedelta(days=5), AUJ + timedelta(days=10)
    db.session.commit()
    parent = connecter(_ouvrir_acces(secretaire, monde))
    assert parent.get('/api/parent/mon-espace').get_json()['enfants'][0]['bulletin']['periodes'] == []
    assert _bulletin(parent, monde).status_code == 404


def test_bulletin_visible_si_rien_d_echu(monde, secretaire, connecter):
    _sequence_terminee(monde)
    _tranche(monde, AUJ + timedelta(days=10))  # pas encore échue
    parent = connecter(_ouvrir_acces(secretaire, monde))
    enfant = parent.get('/api/parent/mon-espace').get_json()['enfants'][0]
    assert enfant['bulletin']['bloque'] is False
    assert f'seq:{monde.sequence_id}' in {p['value'] for p in enfant['bulletin']['periodes']}
    rep = _bulletin(parent, monde)
    assert rep.status_code == 200 and rep.mimetype == 'text/html'


def test_bulletin_grise_si_echeance_passee_impayee_puis_debloque_par_admin(monde, secretaire, admin, connecter):
    _sequence_terminee(monde)
    _tranche(monde, AUJ - timedelta(days=3))
    parent = connecter(_ouvrir_acces(secretaire, monde))
    enfant = parent.get('/api/parent/mon-espace').get_json()['enfants'][0]
    assert enfant['bulletin']['bloque'] is True and enfant['paiements']['impaye_exigible'] == 50000
    rep = _bulletin(parent, monde)
    assert rep.status_code == 403 and rep.get_json()['code'] == 'bulletin_bloque'

    # Le secrétariat ne peut pas lever le blocage, l'administration si.
    url = f'/api/parents/{monde.parent_id}/bulletins/{monde.inscription_id}'
    assert secretaire.put(url, json={'debloque': True}).status_code == 403
    assert admin.put(url, json={'debloque': True}).status_code == 200
    enfant = parent.get('/api/parent/mon-espace').get_json()['enfants'][0]
    assert enfant['bulletin']['bloque'] is False and enfant['bulletin']['debloque_par_admin'] is True
    assert _bulletin(parent, monde).status_code == 200


def test_bulletin_disponible_apres_reglement(monde, secretaire, admin, connecter):
    _sequence_terminee(monde)
    tranche_id = _tranche(monde, AUJ - timedelta(days=3))
    parent = connecter(_ouvrir_acces(secretaire, monde))
    assert _bulletin(parent, monde).status_code == 403
    rep = admin.post('/api/paiements/', json={
        'inscription_id': monde.inscription_id, 'parent_id': monde.parent_id, 'montant_total': 50000,
        'mode_paiement': 'ESPECES', 'lignes': [{'tranche_classe_id': tranche_id, 'montant_verse': 50000}]})
    assert rep.status_code == 201, rep.get_json()
    assert _bulletin(parent, monde).status_code == 200
    versements = parent.get('/api/parent/mon-espace').get_json()['enfants'][0]['versements']
    assert len(versements) == 1 and versements[0]['montant'] == 50000
