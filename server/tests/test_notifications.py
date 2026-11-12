"""Notifications : échéances de paiement (parents), fins de séquence et
saisie incomplète (enseignants), récapitulatif hebdomadaire (admins) ;
idempotence de la génération ; lecture cloisonnée par compte et par rôle."""
from datetime import date, timedelta

import pytest

from extensions import db
from models.inscription_models import Inscription
from models.notification_models import Notification
from models.evaluation_models import Note
from models.paiements_models import TrancheClasse
from models.structure_models import Sequence
from services import notification_services
from services.notification_services import generer_notifications

AUJ = date(2026, 11, 10)  # un mardi


@pytest.fixture(autouse=True)
def generation_neuve():
    """Chaque test part sans passage de génération mémorisé (les
    établissements de test ont tous le même id)."""
    notification_services._DERNIER_PASSAGE.clear()
    yield
    notification_services._DERNIER_PASSAGE.clear()


@pytest.fixture()
def admin(monde, connecter):
    return connecter(monde.admin_compte)


@pytest.fixture()
def parent_id_compte(monde, admin):
    rep = admin.post(f'/api/parents/{monde.parent_id}/acces')
    assert rep.status_code == 201
    data = rep.get_json()
    return {'code_connexion': data['code_connexion'], 'pin_temporaire': data['pin']}


def _tranche(monde, date_limite, ordre=1, montant=40000):
    t = TrancheClasse(classe_id=monde.classe_id, annee_scolaire_id=monde.annee_id, libelle=f'Tranche {ordre}',
                      ordre=ordre, montant_attendu=montant, date_limite=date_limite)
    db.session.add(t)
    db.session.commit()
    return t.id


def _sequence(monde, debut, fin):
    seq = db.session.get(Sequence, monde.sequence_id)
    seq.date_debut, seq.date_fin = debut, fin
    db.session.commit()


def _notifs(role=None, type_=None):
    q = Notification.query
    if role:
        q = q.filter_by(role=role)
    if type_:
        q = q.filter_by(type=type_)
    return q.order_by(Notification.id).all()


# ---------------------------------------------------------------------------
# Parents
# ---------------------------------------------------------------------------

def test_parent_sans_acces_ne_recoit_rien(monde):
    _tranche(monde, AUJ + timedelta(days=5))
    generer_notifications(monde.etab_id, AUJ)
    assert _notifs('Parent') == []


def test_echeance_7_jours_avant_puis_le_jour_meme_puis_retard(monde, parent_id_compte):
    _tranche(monde, AUJ + timedelta(days=5))

    generer_notifications(monde.etab_id, AUJ)
    [j7] = _notifs('Parent')
    assert j7.type == 'echeance_paiement' and j7.niveau == 'info' and '40 000 FCFA' in j7.message

    # Repasser le même jour (ou le lendemain) ne recrée rien.
    assert generer_notifications(monde.etab_id, AUJ) == 0
    assert generer_notifications(monde.etab_id, AUJ + timedelta(days=1)) == 0

    generer_notifications(monde.etab_id, AUJ + timedelta(days=5))
    assert [n.cle.rsplit('|', 1)[1] for n in _notifs('Parent')] == ['J7', 'J0']

    generer_notifications(monde.etab_id, AUJ + timedelta(days=6))
    retard = _notifs('Parent', 'retard_paiement')
    assert len(retard) == 1 and retard[0].niveau == 'urgent' and 'bulletin est suspendu' in retard[0].message


def test_tranche_soldee_ou_lointaine_pas_de_notification(monde, parent_id_compte, admin):
    soldee = _tranche(monde, AUJ + timedelta(days=3), ordre=1)
    _tranche(monde, AUJ + timedelta(days=30), ordre=2)
    rep = admin.post('/api/paiements/', json={
        'inscription_id': monde.inscription_id, 'parent_id': monde.parent_id, 'montant_total': 40000,
        'mode_paiement': 'ESPECES', 'lignes': [{'tranche_classe_id': soldee, 'montant_verse': 40000}]})
    assert rep.status_code == 201
    generer_notifications(monde.etab_id, AUJ)
    assert _notifs('Parent') == []


def test_retard_bulletin_debloque_ne_parle_pas_de_suspension(monde, parent_id_compte):
    _tranche(monde, AUJ - timedelta(days=2))
    db.session.get(Inscription, monde.inscription_id).bulletin_debloque = True
    db.session.commit()
    generer_notifications(monde.etab_id, AUJ)
    [retard] = _notifs('Parent', 'retard_paiement')
    assert 'suspendu' not in retard.message


# ---------------------------------------------------------------------------
# Enseignants
# ---------------------------------------------------------------------------

def _saisir_note(monde):
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=12))
    db.session.commit()


def test_fin_de_sequence_rappel_j7_puis_alertes_si_incomplet(monde):
    _sequence(monde, AUJ - timedelta(days=30), AUJ + timedelta(days=6))
    generer_notifications(monde.etab_id, AUJ)
    [j7] = _notifs('Enseignant')
    assert j7.type == 'fin_sequence' and '0/1 notes' in j7.message

    generer_notifications(monde.etab_id, AUJ + timedelta(days=3))  # J-3
    alerte = _notifs('Enseignant', 'saisie_incomplete')
    assert len(alerte) == 1 and alerte[0].niveau == 'alerte' and 'il manque 1 note' in alerte[0].message

    generer_notifications(monde.etab_id, AUJ + timedelta(days=5))  # J-1
    urgentes = [n for n in _notifs('Enseignant', 'saisie_incomplete') if n.niveau == 'urgent']
    assert len(urgentes) == 1


def test_saisie_complete_pas_d_alerte(monde):
    _sequence(monde, AUJ - timedelta(days=30), AUJ + timedelta(days=3))
    _saisir_note(monde)
    generer_notifications(monde.etab_id, AUJ)
    generer_notifications(monde.etab_id, AUJ + timedelta(days=1))
    assert _notifs('Enseignant') == []


def test_premier_passage_tardif_seule_l_alerte_la_plus_urgente(monde):
    _sequence(monde, AUJ - timedelta(days=30), AUJ + timedelta(days=1))
    generer_notifications(monde.etab_id, AUJ)
    assert [n.cle for n in _notifs('Enseignant')] == [f'sequence|{monde.sequence_id}|J2']


# ---------------------------------------------------------------------------
# Admins
# ---------------------------------------------------------------------------

def test_recapitulatif_hebdomadaire_une_fois_par_semaine(monde):
    _sequence(monde, AUJ - timedelta(days=10), AUJ + timedelta(days=20))
    generer_notifications(monde.etab_id, AUJ)
    generer_notifications(monde.etab_id, AUJ + timedelta(days=2))  # même semaine
    [recap] = _notifs('Admin')
    assert recap.type == 'recap_saisie' and '0 % des notes saisies (0/1)' in recap.message
    generer_notifications(monde.etab_id, AUJ + timedelta(days=7))  # semaine suivante
    assert len(_notifs('Admin')) == 2


def test_pas_de_recap_avant_le_debut_de_la_sequence(monde):
    _sequence(monde, AUJ + timedelta(days=3), AUJ + timedelta(days=30))
    generer_notifications(monde.etab_id, AUJ)
    assert _notifs('Admin') == []


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

def test_api_lecture_cloisonnee_et_marquage(monde, admin, connecter, connecter_superadmin):
    _sequence(monde, AUJ - timedelta(days=30), AUJ + timedelta(days=6))
    generer_notifications(monde.etab_id, AUJ)
    prof = connecter(monde.enseignant_compte)

    data = prof.get('/api/notifications/').get_json()
    assert data['non_lues'] == 1 and data['notifications'][0]['type'] == 'fin_sequence'
    # L'admin ne voit pas les notifications de l'enseignant.
    assert all(n['type'] != 'fin_sequence' for n in admin.get('/api/notifications/').get_json()['notifications'])
    autre = data['notifications'][0]['id']
    assert admin.post(f'/api/notifications/{autre}/lue').status_code == 404

    assert prof.post(f'/api/notifications/{autre}/lue').status_code == 200
    assert prof.get('/api/notifications/').get_json()['non_lues'] == 0

    generer_notifications(monde.etab_id, AUJ + timedelta(days=3))
    assert prof.get('/api/notifications/').get_json()['non_lues'] == 1
    assert prof.post('/api/notifications/tout-lire').get_json()['marquees'] == 1

    superadmin = connecter_superadmin()
    assert superadmin.get('/api/notifications/').get_json() == {'notifications': [], 'non_lues': 0}


def test_api_echeances_saisie(monde, connecter):
    _sequence(monde, AUJ - timedelta(days=30), AUJ + timedelta(days=6))
    prof = connecter(monde.enseignant_compte)
    data = prof.get('/api/notifications/echeances-saisie').get_json()
    assert data['sequences'] == [{'id': monde.sequence_id, 'libelle': 'Seq1',
                                  'date_fin': (AUJ + timedelta(days=6)).isoformat()}]


def test_compte_parent_ouvert_dans_la_journee_notifie_sans_attendre(monde, admin, connecter):
    """Régression : la génération du jour avait déjà eu lieu (lecture par
    l'admin) avant l'ouverture de l'accès parent ; le parent n'était notifié
    que le lendemain."""
    _tranche(monde, date.today() - timedelta(days=2))
    admin.get('/api/notifications/')  # génération déjà passée
    rep = admin.post(f'/api/parents/{monde.parent_id}/acces')
    parent = connecter({'code_connexion': rep.get_json()['code_connexion'], 'pin_temporaire': rep.get_json()['pin']})
    data = parent.get('/api/notifications/').get_json()
    assert [n['type'] for n in data['notifications']] == ['retard_paiement']
