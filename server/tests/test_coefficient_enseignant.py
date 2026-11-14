"""Un enseignant règle le coefficient de SA matière depuis son espace :
périmètre strict (ses seules affectations), valeurs bornées, trace d'audit."""
import pytest

from extensions import db
from models.audit_models import JournalAudit
from models.pedagogie_models import Departement, Enseignant, Grade, Matiere, MatiereClasse
from models.structure_models import Classe, Cycle, Etablissement
from services.authentification_services import create_utilisateur


def _url(mc_id):
    return f'/api/enseignant/matieres-classe/{mc_id}/coefficient'


def _coef_en_base(mc_id):
    db.session.expire_all()
    return db.session.get(MatiereClasse, mc_id).coefficient


def _role_id(nom):
    from models.authentification_models import Role
    return Role.query.filter_by(libelle=nom).first().id


@pytest.fixture()
def collegue(monde):
    """Second enseignant du même établissement, titulaire d'une autre matière
    dans la même classe. Retourne (compte, id de sa matière-classe)."""
    compte, status = create_utilisateur(
        {'nom': 'Collegue Test', 'role_ids': [_role_id('Enseignant')], 'etablissement_id': monde.etab_id})
    assert status == 201, compte
    dep = Departement.query.filter_by(etablissement_id=monde.etab_id).first()
    grade = Grade.query.filter_by(etablissement_id=monde.etab_id).first()
    ens = Enseignant(etablissement_id=monde.etab_id, nom='Collegue', prenom='Test',
                     departement_id=dep.id, grade_id=grade.id, utilisateur_id=compte['id'])
    matiere = Matiere(etablissement_id=monde.etab_id, libelle='Physique',
                      groupe_id=Matiere.query.get(monde.matiere_id).groupe_id)
    db.session.add_all([ens, matiere])
    db.session.flush()
    mc = MatiereClasse(classe_id=monde.classe_id, matiere_id=matiere.id, enseignant_id=ens.id, coefficient=2)
    db.session.add(mc)
    db.session.commit()
    return compte, mc.id


@pytest.fixture()
def autre_etablissement(monde):
    """Matière-classe d'un AUTRE établissement. Retourne son id."""
    etab = Etablissement(code='TST2', nom='Autre lycée')
    db.session.add(etab)
    db.session.flush()
    cycle = Cycle(etablissement_id=etab.id, libelle='6e')
    db.session.add(cycle)
    db.session.flush()
    classe = Classe(etablissement_id=etab.id, cycle_id=cycle.id)
    dep = Departement(etablissement_id=etab.id, libelle='Maths')
    grade = Grade(etablissement_id=etab.id, libelle='PLEG')
    db.session.add_all([classe, dep, grade])
    db.session.flush()
    ens = Enseignant(etablissement_id=etab.id, nom='Etranger', prenom='Prof',
                     departement_id=dep.id, grade_id=grade.id)
    matiere = Matiere(etablissement_id=etab.id, libelle='Maths',
                      groupe_id=Matiere.query.get(monde.matiere_id).groupe_id)
    db.session.add_all([ens, matiere])
    db.session.flush()
    mc = MatiereClasse(classe_id=classe.id, matiere_id=matiere.id, enseignant_id=ens.id, coefficient=3)
    db.session.add(mc)
    db.session.commit()
    return mc.id


def test_enseignant_modifie_le_coefficient_de_sa_matiere(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    rep = prof.put(_url(monde.mc_id), json={'coefficient': 6})
    assert rep.status_code == 200, rep.get_json()
    assert rep.get_json()['coefficient'] == 6
    assert _coef_en_base(monde.mc_id) == 6

    # Visible tout de suite dans « mon espace ».
    espace = prof.get('/api/enseignant/mon-espace').get_json()
    assert [mc['coefficient'] for mc in espace['matieres_classe']] == [6]


def test_modification_tracee_au_nom_de_l_enseignant(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    assert prof.put(_url(monde.mc_id), json={'coefficient': 6}).status_code == 200

    [entree] = JournalAudit.query.filter_by(table_nom='matiere_classe', ligne_id=str(monde.mc_id),
                                            action='modification').all()
    assert entree.changements['coefficient'] == [4, 6]
    assert entree.auteur_id == monde.enseignant_compte['id']
    assert entree.auteur_role == 'Enseignant'


def test_meme_valeur_ne_change_rien(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    assert prof.put(_url(monde.mc_id), json={'coefficient': 4}).status_code == 200
    assert JournalAudit.query.filter_by(table_nom='matiere_classe', action='modification').count() == 0


def test_chaine_numerique_acceptee(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    assert prof.put(_url(monde.mc_id), json={'coefficient': '5'}).status_code == 200
    assert _coef_en_base(monde.mc_id) == 5


@pytest.mark.parametrize('valeur', [0, -1, 100, 2.5, 'abc', '', '2.5', '²', True, None, [3], {'a': 1}])
def test_valeurs_invalides_refusees(monde, connecter, valeur):
    prof = connecter(monde.enseignant_compte)
    rep = prof.put(_url(monde.mc_id), json={'coefficient': valeur})
    assert rep.status_code == 400, rep.get_json()
    assert _coef_en_base(monde.mc_id) == 4


def test_bornes_acceptees(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    assert prof.put(_url(monde.mc_id), json={'coefficient': 1}).status_code == 200
    assert prof.put(_url(monde.mc_id), json={'coefficient': 99}).status_code == 200
    assert _coef_en_base(monde.mc_id) == 99


def test_coefficient_obligatoire(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    assert prof.put(_url(monde.mc_id), json={'autre': 1}).status_code == 400


def test_matiere_d_un_collegue_interdite(monde, connecter, collegue):
    _, mc_collegue = collegue
    prof = connecter(monde.enseignant_compte)
    rep = prof.put(_url(mc_collegue), json={'coefficient': 9})
    assert rep.status_code == 404
    assert _coef_en_base(mc_collegue) == 2
    # Valeur invalide sur la matière d'un autre : toujours 404, pas 400
    # (l'existence de la matière ne doit pas fuiter).
    assert prof.put(_url(mc_collegue), json={'coefficient': 0}).status_code == 404


def test_matiere_d_un_autre_etablissement_interdite(monde, connecter, autre_etablissement):
    prof = connecter(monde.enseignant_compte)
    assert prof.put(_url(autre_etablissement), json={'coefficient': 9}).status_code == 404
    assert _coef_en_base(autre_etablissement) == 3


def test_matiere_inexistante(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    assert prof.put(_url(99999), json={'coefficient': 3}).status_code == 404


def test_les_autres_champs_ne_sont_pas_modifiables(monde, connecter, collegue):
    """Le corps n'est lu que pour « coefficient » : impossible de s'octroyer
    une autre matière ou de se réaffecter."""
    compte_collegue, _ = collegue
    ens_collegue = Enseignant.query.filter_by(utilisateur_id=compte_collegue['id']).first()
    prof = connecter(monde.enseignant_compte)
    rep = prof.put(_url(monde.mc_id), json={'coefficient': 5, 'enseignant_id': ens_collegue.id,
                                            'classe_id': 999, 'matiere_id': 999})
    assert rep.status_code == 200
    db.session.expire_all()
    mc = db.session.get(MatiereClasse, monde.mc_id)
    assert (mc.enseignant_id, mc.classe_id, mc.matiere_id) == (monde.enseignant_id, monde.classe_id, monde.matiere_id)


@pytest.mark.parametrize('compte', ['admin_compte', 'censeur_compte'])
def test_autres_roles_refuses(monde, connecter, compte):
    client = connecter(getattr(monde, compte))
    rep = client.put(_url(monde.mc_id), json={'coefficient': 9})
    assert rep.status_code == 403
    assert _coef_en_base(monde.mc_id) == 4


def test_non_connecte_refuse(monde, appli):
    rep = appli.test_client().put(_url(monde.mc_id), json={'coefficient': 9})
    assert rep.status_code == 401
    assert _coef_en_base(monde.mc_id) == 4


def test_enseignant_sans_profil_relie(monde, connecter):
    """Compte Enseignant non relié à un profil : message actionnable."""
    compte, status = create_utilisateur(
        {'nom': 'Sans Profil', 'role_ids': [_role_id('Enseignant')], 'etablissement_id': monde.etab_id})
    assert status == 201
    client = connecter(compte)
    rep = client.put(_url(monde.mc_id), json={'coefficient': 3})
    assert rep.status_code == 404
    assert 'profil enseignant' in rep.get_json()['erreur']
    assert _coef_en_base(monde.mc_id) == 4
