"""Désignation d'un enseignant principal (titulaire de classe) : réservée à
l'Admin et au SuperAdmin, sur l'année active, une classe par enseignant et un
titulaire par classe, avec remplacement explicite et trace d'audit."""
import pytest

from extensions import db
from models.audit_models import JournalAudit
from models.authentification_models import Role
from models.pedagogie_models import Departement, Enseignant, Grade, TitulaireClasse
from models.structure_models import AnneeScolaire, Classe, Cycle, Etablissement
from services.authentification_services import create_utilisateur


def _url(enseignant_id, etab=None):
    return f'/api/enseignants/{enseignant_id}/titulaire' + (f'?etablissement_id={etab}' if etab else '')


def _titulaires(annee_id=None):
    db.session.expire_all()
    q = TitulaireClasse.query
    if annee_id:
        q = q.filter_by(annee_scolaire_id=annee_id)
    return sorted((t.classe_id, t.enseignant_id, t.annee_scolaire_id) for t in q.all())


def _nouvelle_classe(etab_id, libelle='5e'):
    cycle = Cycle(etablissement_id=etab_id, libelle=libelle)
    db.session.add(cycle)
    db.session.flush()
    classe = Classe(etablissement_id=etab_id, cycle_id=cycle.id)
    db.session.add(classe)
    db.session.commit()
    return classe.id


@pytest.fixture()
def classe_b(monde):
    return _nouvelle_classe(monde.etab_id)


@pytest.fixture()
def collegue(monde):
    dep = Departement.query.filter_by(etablissement_id=monde.etab_id).first()
    grade = Grade.query.filter_by(etablissement_id=monde.etab_id).first()
    ens = Enseignant(etablissement_id=monde.etab_id, nom='Collegue', prenom='Paul',
                     departement_id=dep.id, grade_id=grade.id)
    db.session.add(ens)
    db.session.commit()
    return ens.id


@pytest.fixture()
def autre_etablissement(monde):
    """(classe_id, enseignant_id) d'un AUTRE établissement."""
    etab = Etablissement(code='TST2', nom='Autre lycée')
    db.session.add(etab)
    db.session.flush()
    classe_id = _nouvelle_classe(etab.id)
    dep = Departement(etablissement_id=etab.id, libelle='Maths')
    grade = Grade(etablissement_id=etab.id, libelle='PLEG')
    db.session.add_all([dep, grade])
    db.session.flush()
    ens = Enseignant(etablissement_id=etab.id, nom='Etranger', prenom='Prof',
                     departement_id=dep.id, grade_id=grade.id)
    db.session.add(ens)
    db.session.commit()
    return classe_id, ens.id


# ── Désignation ─────────────────────────────────────────────────────────────

def test_admin_designe_un_titulaire(monde, connecter):
    admin = connecter(monde.admin_compte)
    rep = admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    assert rep.status_code == 200, rep.get_json()
    corps = rep.get_json()
    assert corps['classe_id'] == monde.classe_id
    assert corps['annee_scolaire_id'] == monde.annee_id
    assert _titulaires() == [(monde.classe_id, monde.enseignant_id, monde.annee_id)]
    # L'API de lecture existante reflète le changement.
    assert admin.get(f'/api/enseignants/{monde.enseignant_id}').get_json()['est_titulaire'] is True


def test_superadmin_designe_un_titulaire(monde, connecter_superadmin):
    sa = connecter_superadmin()
    rep = sa.put(_url(monde.enseignant_id, monde.etab_id), json={'classe_id': monde.classe_id})
    assert rep.status_code == 200, rep.get_json()
    assert _titulaires() == [(monde.classe_id, monde.enseignant_id, monde.annee_id)]


def test_superadmin_sans_etablissement_refuse(monde, connecter_superadmin):
    sa = connecter_superadmin()
    rep = sa.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    assert rep.status_code == 400
    assert _titulaires() == []


def test_designation_idempotente(monde, connecter):
    admin = connecter(monde.admin_compte)
    for _ in range(2):
        assert admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id}).status_code == 200
    assert _titulaires() == [(monde.classe_id, monde.enseignant_id, monde.annee_id)]
    assert JournalAudit.query.filter_by(table_nom='titulaire_classe', action='creation').count() == 1


def test_changer_de_classe_libere_l_ancienne(monde, connecter, classe_b):
    admin = connecter(monde.admin_compte)
    admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    rep = admin.put(_url(monde.enseignant_id), json={'classe_id': classe_b})
    assert rep.status_code == 200, rep.get_json()
    assert _titulaires() == [(classe_b, monde.enseignant_id, monde.annee_id)]


def test_retirer_le_titulariat(monde, connecter):
    admin = connecter(monde.admin_compte)
    admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    rep = admin.put(_url(monde.enseignant_id), json={'classe_id': None})
    assert rep.status_code == 200
    assert rep.get_json()['classe_id'] is None
    assert _titulaires() == []
    # Retirer alors qu'il n'est titulaire de rien reste sans erreur.
    assert admin.put(_url(monde.enseignant_id), json={'classe_id': None}).status_code == 200


# ── Conflit : une classe n'a qu'un titulaire ────────────────────────────────

def test_classe_deja_prise_refusee(monde, connecter, collegue):
    admin = connecter(monde.admin_compte)
    admin.put(_url(collegue), json={'classe_id': monde.classe_id})
    rep = admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    assert rep.status_code == 409
    corps = rep.get_json()
    assert corps['code'] == 'classe_deja_titulaire'
    assert corps['titulaire_actuel']['enseignant_id'] == collegue
    assert 'Paul Collegue' in corps['erreur']
    assert _titulaires() == [(monde.classe_id, collegue, monde.annee_id)]


def test_remplacement_explicite(monde, connecter, collegue):
    admin = connecter(monde.admin_compte)
    admin.put(_url(collegue), json={'classe_id': monde.classe_id})
    rep = admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id, 'remplacer': True})
    assert rep.status_code == 200, rep.get_json()
    assert _titulaires() == [(monde.classe_id, monde.enseignant_id, monde.annee_id)]


def test_remplacement_refuse_si_pas_booleen_vrai(monde, connecter, collegue):
    admin = connecter(monde.admin_compte)
    admin.put(_url(collegue), json={'classe_id': monde.classe_id})
    for valeur in ('true', 1, 'oui'):
        rep = admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id, 'remplacer': valeur})
        assert rep.status_code == 409
    assert _titulaires() == [(monde.classe_id, collegue, monde.annee_id)]


def test_remplacement_et_changement_de_classe_atomiques(monde, connecter, collegue, classe_b):
    """L'enseignant quitte sa classe actuelle ET prend celle du collègue."""
    admin = connecter(monde.admin_compte)
    admin.put(_url(monde.enseignant_id), json={'classe_id': classe_b})
    admin.put(_url(collegue), json={'classe_id': monde.classe_id})
    rep = admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id, 'remplacer': True})
    assert rep.status_code == 200
    assert _titulaires() == [(monde.classe_id, monde.enseignant_id, monde.annee_id)]


# ── Périmètre : année et établissement ──────────────────────────────────────

def test_historique_des_autres_annees_intact(monde, connecter):
    ancienne = AnneeScolaire(etablissement_id=monde.etab_id, libelle='2025-2026', active=False)
    db.session.add(ancienne)
    db.session.flush()
    db.session.add(TitulaireClasse(classe_id=monde.classe_id, enseignant_id=monde.enseignant_id,
                                   annee_scolaire_id=ancienne.id))
    db.session.commit()
    ancienne_id = ancienne.id

    admin = connecter(monde.admin_compte)
    admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    admin.put(_url(monde.enseignant_id), json={'classe_id': None})
    assert _titulaires() == [(monde.classe_id, monde.enseignant_id, ancienne_id)]


def test_sans_annee_scolaire(monde, connecter):
    AnneeScolaire.query.delete()
    db.session.commit()
    admin = connecter(monde.admin_compte)
    rep = admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    assert rep.status_code == 400


def test_classe_d_un_autre_etablissement(monde, connecter, autre_etablissement):
    classe_etrangere, _ = autre_etablissement
    admin = connecter(monde.admin_compte)
    rep = admin.put(_url(monde.enseignant_id), json={'classe_id': classe_etrangere})
    assert rep.status_code == 400
    assert _titulaires() == []


def test_enseignant_d_un_autre_etablissement(monde, connecter, autre_etablissement):
    _, enseignant_etranger = autre_etablissement
    admin = connecter(monde.admin_compte)
    rep = admin.put(_url(enseignant_etranger), json={'classe_id': monde.classe_id})
    assert rep.status_code == 404
    assert _titulaires() == []


def test_enseignant_inexistant(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert admin.put(_url(99999), json={'classe_id': monde.classe_id}).status_code == 404


# ── Validation du corps ─────────────────────────────────────────────────────

@pytest.mark.parametrize('valeur', [True, 1.5, 'abc', -1, 0, 99999, [1], {'id': 1}])
def test_classe_id_invalide(monde, connecter, valeur):
    admin = connecter(monde.admin_compte)
    rep = admin.put(_url(monde.enseignant_id), json={'classe_id': valeur})
    assert rep.status_code == 400
    assert _titulaires() == []


def test_classe_id_obligatoire(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert admin.put(_url(monde.enseignant_id), json={}).status_code == 400


def test_classe_id_en_chaine_numerique(monde, connecter):
    admin = connecter(monde.admin_compte)
    rep = admin.put(_url(monde.enseignant_id), json={'classe_id': str(monde.classe_id)})
    assert rep.status_code == 200
    assert _titulaires() == [(monde.classe_id, monde.enseignant_id, monde.annee_id)]


# ── Droits : Admin et SuperAdmin uniquement ─────────────────────────────────

def test_censeur_ne_peut_pas_designer(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    rep = censeur.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    assert rep.status_code == 403
    assert _titulaires() == []


def test_enseignant_ne_peut_pas_se_designer(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    rep = prof.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    assert rep.status_code == 403
    assert _titulaires() == []


def test_non_connecte_refuse(monde, appli):
    rep = appli.test_client().put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    assert rep.status_code == 401
    assert _titulaires() == []


@pytest.mark.parametrize('role', ['Surveillant', 'Secretaire', 'Comptable', 'Proviseur', 'Parent'])
def test_autres_roles_refuses(monde, connecter, role):
    compte, status = create_utilisateur({'nom': f'{role} Test',
                                         'role_ids': [Role.query.filter_by(libelle=role).first().id],
                                         'etablissement_id': monde.etab_id})
    assert status == 201, compte
    rep = connecter(compte).put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    assert rep.status_code in (401, 403)
    assert _titulaires() == []


def test_api_generique_fermee_au_censeur(monde, connecter):
    """POST/PUT/DELETE /api/titulaires-classe/ ne servent plus au Censeur
    (même pour une classe qui lui est assignée) ; la lecture reste ouverte."""
    admin = connecter(monde.admin_compte)
    admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id})
    [t] = TitulaireClasse.query.all()

    censeur = connecter(monde.censeur_compte)
    assert censeur.get('/api/titulaires-classe/').status_code == 200
    rep = censeur.post('/api/titulaires-classe/', json={
        'classe_id': monde.classe_id, 'enseignant_id': monde.enseignant_id,
        'annee_scolaire_id': monde.annee_id})
    assert rep.status_code == 403
    assert censeur.put(f'/api/titulaires-classe/{t.id}', json={'enseignant_id': monde.enseignant_id}).status_code == 403
    assert censeur.delete(f'/api/titulaires-classe/{t.id}').status_code == 403
    assert len(_titulaires()) == 1


def test_api_generique_toujours_ouverte_a_l_admin(monde, connecter):
    admin = connecter(monde.admin_compte)
    rep = admin.post('/api/titulaires-classe/', json={
        'classe_id': monde.classe_id, 'enseignant_id': monde.enseignant_id,
        'annee_scolaire_id': monde.annee_id})
    assert rep.status_code == 201, rep.get_json()


# ── Audit ───────────────────────────────────────────────────────────────────

def test_designation_et_remplacement_traces(monde, connecter, collegue):
    admin = connecter(monde.admin_compte)
    admin.put(_url(collegue), json={'classe_id': monde.classe_id})
    admin.put(_url(monde.enseignant_id), json={'classe_id': monde.classe_id, 'remplacer': True})

    entrees = JournalAudit.query.filter_by(table_nom='titulaire_classe').all()
    actions = sorted(e.action for e in entrees)
    assert actions == ['creation', 'creation', 'suppression']
    assert {e.auteur_id for e in entrees} == {monde.admin_compte['id']}
    assert {e.auteur_role for e in entrees} == {'Admin'}
