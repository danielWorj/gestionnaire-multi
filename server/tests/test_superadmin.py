"""Supervision SuperAdmin : vue réseau, comptes SuperAdmin (garde-fous),
journal multi-établissements, accès refusé aux autres rôles."""
from datetime import date
from decimal import Decimal

import pytest

from extensions import db
from models.authentification_models import SuperAdmin
from models.paiements_models import TrancheClasse
from models.structure_models import Etablissement


@pytest.fixture()
def superadmin(monde, connecter_superadmin):
    return connecter_superadmin()


def _ligne(vue, etab_id):
    return next(l for l in vue['etablissements'] if l['id'] == etab_id)


def test_vue_reseau_indicateurs(monde, superadmin):
    db.session.add(TrancheClasse(classe_id=monde.classe_id, annee_scolaire_id=monde.annee_id,
                                 libelle='T1', ordre=1, montant_attendu=Decimal('50000'), date_limite=date(2026, 10, 1)))
    db.session.add(Etablissement(code='TST2', nom='Collège vide'))
    db.session.commit()

    rep = superadmin.get('/api/superadmin/vue-reseau')
    assert rep.status_code == 200, rep.get_json()
    vue = rep.get_json()
    assert vue['totaux']['etablissements'] == 2

    ligne = _ligne(vue, monde.etab_id)
    assert ligne['effectifs']['inscrits'] == 1
    assert ligne['effectifs']['filles'] == 1
    assert ligne['effectifs']['classes'] == 1
    assert ligne['annee']['libelle'] == '2026-2027'
    assert ligne['finances'] == {'attendu': 50000.0, 'encaisse': 0.0, 'taux': 0.0}
    assert ligne['notes']['attendues'] == 1 and ligne['notes']['saisies'] == 0
    assert ligne['comptes']['admins_actifs'] == 1
    assert not any(a['code'] == 'sans_admin' for a in ligne['alertes'])

    vide = next(l for l in vue['etablissements'] if l['code'] == 'TST2')
    codes = {a['code'] for a in vide['alertes']}
    assert {'sans_admin', 'sans_annee'} <= codes
    # Journal tout neuf : pas d'alerte d'inactivité (elle serait fausse).
    assert 'inactif' not in codes
    assert len(vue['activite']) == vue['jours_activite']


def test_vue_reseau_notes_saisies(monde, superadmin, connecter):
    prof = connecter(monde.enseignant_compte)
    rep = prof.post('/api/notes/', json={'inscription_id': monde.inscription_id, 'matiere_classe_id': monde.mc_id,
                                         'sequence_id': monde.sequence_id, 'valeur': 14, 'absent': False})
    assert rep.status_code == 201, rep.get_json()
    ligne = _ligne(superadmin.get('/api/superadmin/vue-reseau').get_json(), monde.etab_id)
    assert ligne['notes'] == {'saisies': 1, 'attendues': 1, 'taux': 100.0}
    assert ligne['activite']['modifications'] >= 1


def test_supervision_refusee_aux_autres_roles(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert admin.get('/api/superadmin/vue-reseau').status_code == 403
    assert admin.get('/api/superadmin/comptes').status_code == 403
    assert admin.post('/api/superadmin/comptes', json={'nom': 'X', 'email': 'x@x.cm'}).status_code == 403


def test_creation_superadmin_mot_de_passe_genere(appli, monde, superadmin):
    rep = superadmin.post('/api/superadmin/comptes', json={'nom': 'Second', 'email': 'Second@Test.cm', 'password': 'ignore1'})
    assert rep.status_code == 201, rep.get_json()
    cree = rep.get_json()
    assert cree['email'] == 'second@test.cm'
    mdp = cree['mot_de_passe']
    assert mdp != 'ignore1' and len(mdp) == 12

    client = appli.test_client()
    assert client.post('/api/auth/superadmin/login', json={'email': 'second@test.cm', 'password': mdp}).status_code == 200
    assert 'mot_de_passe' not in superadmin.get('/api/superadmin/comptes').get_json()[0]

    doublon = superadmin.post('/api/superadmin/comptes', json={'nom': 'Bis', 'email': 'second@test.cm'})
    assert doublon.status_code == 409


def test_garde_fous_superadmin(monde, superadmin):
    # Ni désactivation de soi-même, ni réinitialisation de son propre mot de passe.
    assert superadmin.put(f'/api/superadmin/comptes/{superadmin.id}', json={'actif': False}).status_code == 400
    assert superadmin.post(f'/api/superadmin/comptes/{superadmin.id}/reinitialiser').status_code == 400

    autre = superadmin.post('/api/superadmin/comptes', json={'nom': 'Autre', 'email': 'autre@test.cm'}).get_json()
    rep = superadmin.post(f"/api/superadmin/comptes/{autre['id']}/reinitialiser")
    assert rep.status_code == 200 and rep.get_json()['mot_de_passe'] != autre['mot_de_passe']

    rep = superadmin.put(f"/api/superadmin/comptes/{autre['id']}", json={'actif': False})
    assert rep.status_code == 200 and rep.get_json()['actif'] is False


def test_dernier_superadmin_actif_protege(appli):
    """Garde-fou du service, indépendant de l'appelant : le dernier compte
    SuperAdmin actif ne peut jamais être désactivé. (Par l'API, l'appelant
    est lui-même actif : il y a donc toujours un autre actif, ou c'est
    lui-même, refusé par la règle « pas soi-même ».)"""
    from services.superadmin_services import modifier_superadmin
    seul = SuperAdmin(nom='Seul', email='seul@test.cm', actif=True)
    seul.set_password('Motdepasse1')
    db.session.add(seul)
    db.session.commit()
    resultat, status = modifier_superadmin(seul.id, {'actif': False}, courant_id=seul.id + 1000)
    assert status == 400 and 'dernier' in resultat['erreur']
    assert db.session.get(SuperAdmin, seul.id).actif is True


def test_journal_tous_les_etablissements(monde, superadmin, connecter):
    prof = connecter(monde.enseignant_compte)
    prof.post('/api/notes/', json={'inscription_id': monde.inscription_id, 'matiere_classe_id': monde.mc_id,
                                   'sequence_id': monde.sequence_id, 'valeur': 9, 'absent': False})
    tous = superadmin.get('/api/audit/?etablissement_id=tous').get_json()
    un = superadmin.get(f'/api/audit/?etablissement_id={monde.etab_id}').get_json()
    autre = superadmin.get('/api/audit/?etablissement_id=999').get_json()
    assert tous['total'] >= un['total'] >= 1
    assert autre['total'] == 0
    assert superadmin.get('/api/audit/?etablissement_id=abc').status_code == 400


# ── Saisie pour le compte d'un établissement (zone sans réseau, etc.) ─────

def _corps_note(monde, valeur):
    return {'inscription_id': monde.inscription_id, 'matiere_classe_id': monde.mc_id,
            'sequence_id': monde.sequence_id, 'valeur': valeur, 'absent': False}


def test_superadmin_saisit_et_corrige_une_note(monde, superadmin):
    url = f'/api/notes/?etablissement_id={monde.etab_id}'
    rep = superadmin.post(url, json={**_corps_note(monde, 11), 'version_base': None})
    assert rep.status_code == 201, rep.get_json()
    note = rep.get_json()

    rep = superadmin.put(f"/api/notes/{note['id']}?etablissement_id={monde.etab_id}",
                         json={**_corps_note(monde, 13.5), 'version_base': note['version']})
    assert rep.status_code == 200, rep.get_json()
    assert float(rep.get_json()['valeur']) == 13.5

    from models.audit_models import JournalAudit
    derniere = JournalAudit.query.filter_by(table_nom='note').order_by(JournalAudit.id.desc()).first()
    assert derniere.auteur_type == 'superadmin' and derniere.auteur_role == 'SuperAdmin'

    autre = superadmin.post('/api/notes/?etablissement_id=999', json=_corps_note(monde, 9))
    assert autre.status_code == 400  # matière/élève hors de l'établissement indiqué


def test_saisie_des_notes_toujours_refusee_a_l_admin_et_au_censeur(monde, connecter):
    for compte in (monde.admin_compte, monde.censeur_compte):
        client = connecter(compte)
        assert client.post('/api/notes/', json=_corps_note(monde, 10)).status_code == 403


def test_superadmin_discipline_et_emploi_du_temps(monde, superadmin):
    q = f'?etablissement_id={monde.etab_id}'
    rep = superadmin.post(f'/api/disciplines/{q}', json={'inscription_id': monde.inscription_id, 'sequence_id': monde.sequence_id,
                                                         'absences_justifiees': 2, 'retards': 1})
    assert rep.status_code == 201, rep.get_json()

    rep = superadmin.post(f'/api/creneaux-horaires/{q}', json={'etablissement_id': monde.etab_id, 'libelle': 'H1',
                                                               'heure_debut': '07:30', 'heure_fin': '08:25'})
    assert rep.status_code == 201, rep.get_json()
    creneau_id = rep.get_json()['id']
    rep = superadmin.post(f'/api/horaires/{q}', json={'matiere_classe_id': monde.mc_id, 'annee_scolaire_id': monde.annee_id,
                                                      'jour_semaine': 'Lundi', 'creneau_id': creneau_id})
    assert rep.status_code == 201, rep.get_json()
    horaire = rep.get_json()
    rep = superadmin.put(f"/api/horaires/{horaire['id']}{q}", json={'salle': 'B12'})
    assert rep.status_code == 200, rep.get_json()
    assert superadmin.delete(f"/api/horaires/{horaire['id']}{q}").status_code in (200, 204)


# ── Cohérence avec le reste de l'application ─────────────────────────────

def test_vue_reseau_memes_chiffres_que_l_espace_censeur(monde, superadmin, connecter):
    """Avancement des notes : la vue réseau et les cartes de classes de
    l'espace Censeur reposent sur les mêmes règles (année, séquence,
    effectif, notes saisies) et donnent donc les mêmes chiffres."""
    from models.inscription_models import Eleve, Inscription
    # Un élève SUSPENDU fait partie de l'effectif (inscription en cours).
    eleve = Eleve(etablissement_id=monde.etab_id, matricule='M002', nom='Eleve', prenom='Deux', sexe='M',
                  lieu_naissance='Douala', parent_id=monde.parent_id)
    db.session.add(eleve)
    db.session.flush()
    db.session.add(Inscription(eleve_id=eleve.id, classe_id=monde.classe_id, annee_scolaire_id=monde.annee_id,
                               date_inscription=date(2026, 9, 2), statut='Suspendu'))
    db.session.commit()
    prof = connecter(monde.enseignant_compte)
    assert prof.post('/api/notes/', json=_corps_note(monde, 12)).status_code == 201

    espace = superadmin.get(f'/api/censeur/mon-espace?etablissement_id={monde.etab_id}').get_json()
    [classe] = espace['classes']
    ligne = _ligne(superadmin.get('/api/superadmin/vue-reseau').get_json(), monde.etab_id)
    assert ligne['sequence']['id'] == espace['sequence_courante']['id']
    assert ligne['notes']['saisies'] == classe['notes_saisies'] == 1
    assert ligne['notes']['attendues'] == classe['notes_attendues'] == 2
    assert ligne['effectifs']['inscrits'] == classe['effectif'] == 2


def test_alerte_inactivite_quand_le_journal_a_de_l_historique(monde, superadmin):
    from datetime import datetime, timedelta
    from models.audit_models import JournalAudit
    db.session.add(Etablissement(code='TST3', nom='Lycée silencieux'))
    db.session.add(JournalAudit(horodatage=datetime.utcnow() - timedelta(days=30), action='creation',
                                table_nom='eleve', ligne_id='1', etablissement_id=monde.etab_id,
                                auteur_type='systeme'))
    db.session.commit()
    vue = superadmin.get('/api/superadmin/vue-reseau').get_json()
    silencieux = next(l for l in vue['etablissements'] if l['code'] == 'TST3')
    assert any(a['code'] == 'inactif' for a in silencieux['alertes'])


def test_activite_decoupee_en_jours_locaux(appli, monde, superadmin):
    """Une modification faite à 23h30 UTC tombe le LENDEMAIN en heure du
    Cameroun (UTC+1)."""
    from datetime import datetime, timedelta
    from models.audit_models import JournalAudit
    from services import superadmin_services
    hier_local = (datetime.utcnow() + timedelta(hours=1)).date() - timedelta(days=1)
    tard_utc = datetime.combine(hier_local - timedelta(days=1), datetime.min.time()) + timedelta(hours=23, minutes=30)
    db.session.add(JournalAudit(horodatage=tard_utc, action='modification', table_nom='eleve', ligne_id='1',
                                etablissement_id=monde.etab_id, auteur_type='systeme'))
    db.session.commit()
    serie = {j['jour']: j['modifications'] for j in superadmin_services.vue_reseau()['activite']}
    assert serie[hier_local.isoformat()] >= 1


def test_connexion_superadmin_insensible_a_la_casse(appli, monde, superadmin):
    cree = superadmin.post('/api/superadmin/comptes', json={'nom': 'Casse', 'email': 'casse@test.cm'}).get_json()
    client = appli.test_client()
    rep = client.post('/api/auth/superadmin/login', json={'email': '  Casse@Test.CM ', 'password': cree['mot_de_passe']})
    assert rep.status_code == 200, rep.get_json()
