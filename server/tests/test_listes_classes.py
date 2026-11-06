"""Listes de classe : tous les profils y ont accès, chacun sur ses classes,
et les coordonnées des parents restent réservées aux rôles qui les lisent
déjà."""
from extensions import db
from models.authentification_models import Role
from models.structure_models import Classe
from services.authentification_services import create_utilisateur


def _compte(monde, nom, role):
    role_id = Role.query.filter_by(libelle=role).first().id
    res, status = create_utilisateur({'nom': nom, 'role_ids': [role_id], 'etablissement_id': monde.etab_id})
    assert status == 201, res
    return res


def _eleves(api, monde, **params):
    query = '&'.join(f'{k}={v}' for k, v in {'annee_scolaire_id': monde.annee_id, **params}.items())
    return api.get(f'/api/listes-classes/eleves?{query}')


def _autre_classe(monde):
    autre = Classe(etablissement_id=monde.etab_id, cycle_id=Classe.query.get(monde.classe_id).cycle_id, option='B')
    db.session.add(autre)
    db.session.commit()
    return autre.id


def test_tous_les_profils_telechargent_leur_liste(monde, connecter):
    comptes = {
        'Admin': monde.admin_compte,
        'Censeur': monde.censeur_compte,
        'Enseignant': monde.enseignant_compte,
        'Secretaire': _compte(monde, 'Secr Test', 'Secretaire'),
        'Comptable': _compte(monde, 'Compta Test', 'Comptable'),
    }
    for role, compte in comptes.items():
        api = connecter(compte)
        ctx = api.get('/api/listes-classes/')
        assert ctx.status_code == 200, (role, ctx.get_json())
        assert [c['id'] for c in ctx.get_json()['classes']] == [monde.classe_id], role
        rep = _eleves(api, monde)
        assert rep.status_code == 200, (role, rep.get_json())
        assert [l['matricule'] for l in rep.get_json()] == ['M001'], role


def test_superadmin(monde, connecter_superadmin):
    api = connecter_superadmin()
    rep = api.get(f'/api/listes-classes/eleves?annee_scolaire_id={monde.annee_id}&etablissement_id={monde.etab_id}')
    assert rep.status_code == 200
    assert len(rep.get_json()) == 1


def test_perimetre_des_classes(monde, connecter):
    autre_id = _autre_classe(monde)
    # L'administration voit les deux classes ; censeur et enseignant seulement la leur.
    admin = connecter(monde.admin_compte)
    assert {c['id'] for c in admin.get('/api/listes-classes/').get_json()['classes']} == {monde.classe_id, autre_id}
    assert _eleves(admin, monde, classe_id=autre_id).status_code == 200
    for compte in (monde.censeur_compte, monde.enseignant_compte):
        api = connecter(compte)
        assert [c['id'] for c in api.get('/api/listes-classes/').get_json()['classes']] == [monde.classe_id]
        assert _eleves(api, monde, classe_id=autre_id).status_code == 403


def test_coordonnees_parents_reservees(monde, connecter):
    admin = _eleves(connecter(monde.admin_compte), monde).get_json()[0]
    assert admin['parent_telephone'] == '600000000'
    for compte in (monde.censeur_compte, monde.enseignant_compte):
        api = connecter(compte)
        assert api.get('/api/listes-classes/').get_json()['avec_parents'] is False
        ligne = _eleves(api, monde).get_json()[0]
        assert 'parent_telephone' not in ligne and 'parent_nom' not in ligne


def test_role_sans_espace_refuse(monde, connecter):
    api = connecter(_compte(monde, 'Infirmier Test', 'Infirmier'))
    assert api.get('/api/listes-classes/').status_code == 403
