"""Paiements saisis hors connexion : jamais de double encaissement (clé
d'idempotence), date réelle de l'encaissement, doublon probable soumis à
l'utilisateur, refus si le reste dû a changé entre-temps."""
import pytest

from extensions import db
from models.paiements_models import Paiement, TrancheClasse


@pytest.fixture()
def tranche(monde):
    t = TrancheClasse(classe_id=monde.classe_id, annee_scolaire_id=monde.annee_id, libelle='Tranche 1',
                      ordre=1, montant_attendu=50000)
    db.session.add(t)
    db.session.commit()
    return t.id


def _paiement(monde, tranche, montant=20000, **kw):
    body = {'inscription_id': monde.inscription_id, 'parent_id': monde.parent_id, 'montant_total': montant,
            'mode_paiement': 'ESPECES', 'lignes': [{'tranche_classe_id': tranche, 'montant_verse': montant}]}
    body.update(kw)
    return body


def test_renvoi_avec_meme_cle_n_encaisse_pas_deux_fois(monde, connecter, tranche):
    admin = connecter(monde.admin_compte)
    body = _paiement(monde, tranche, cle_idempotence='appareil-1-abc', version_base=None)
    premier = admin.post('/api/paiements/', json=body)
    assert premier.status_code == 201, premier.get_json()
    second = admin.post('/api/paiements/', json=body)
    assert second.status_code == 200
    assert second.get_json()['id'] == premier.get_json()['id']
    assert Paiement.query.count() == 1


def test_date_de_l_encaissement_reel(monde, connecter, tranche):
    admin = connecter(monde.admin_compte)
    rep = admin.post('/api/paiements/', json=_paiement(monde, tranche, cle_idempotence='k2'),
                     headers={'X-Saisi-Hors-Ligne-Le': '2026-11-03T07:45:00Z'})
    assert rep.status_code == 201
    assert rep.get_json()['date_paiement'].startswith('2026-11-03T07:45:00')


def test_doublon_probable_puis_enregistrer_quand_meme(monde, connecter, tranche):
    admin = connecter(monde.admin_compte)
    assert admin.post('/api/paiements/', json=_paiement(monde, tranche, cle_idempotence='a', version_base=None)).status_code == 201
    rep = admin.post('/api/paiements/', json=_paiement(monde, tranche, cle_idempotence='b', version_base=None))
    assert rep.status_code == 409
    data = rep.get_json()
    assert data['code'] == 'doublon'
    assert data['serveur']['montant_total'] == 20000
    assert data['modification']['auteur']['nom'] == 'Admin Test'
    assert Paiement.query.count() == 1

    rep = admin.post('/api/paiements/', json=_paiement(monde, tranche, cle_idempotence='b', version_base=None, forcer=True))
    assert rep.status_code == 201
    assert Paiement.query.count() == 2


def test_montant_different_n_est_pas_un_doublon(monde, connecter, tranche):
    admin = connecter(monde.admin_compte)
    admin.post('/api/paiements/', json=_paiement(monde, tranche, cle_idempotence='a', version_base=None))
    rep = admin.post('/api/paiements/', json=_paiement(monde, tranche, montant=5000, cle_idempotence='c', version_base=None))
    assert rep.status_code == 201


def test_trop_percu_refuse_a_la_synchro(monde, connecter, tranche):
    """Deux caisses encaissent hors ligne la même tranche : la seconde est
    refusée (reste dû dépassé), rien n'est écrit."""
    admin = connecter(monde.admin_compte)
    admin.post('/api/paiements/', json=_paiement(monde, tranche, montant=40000, cle_idempotence='x'))
    rep = admin.post('/api/paiements/', json=_paiement(monde, tranche, montant=30000, cle_idempotence='y'))
    assert rep.status_code == 400
    assert 'reste dû' in rep.get_json()['erreur']
    assert Paiement.query.count() == 1


def test_audit_du_paiement(monde, connecter, tranche):
    from models.audit_models import JournalAudit
    admin = connecter(monde.admin_compte)
    p = admin.post('/api/paiements/', json=_paiement(monde, tranche, cle_idempotence='z'),
                   headers={'X-Saisi-Hors-Ligne-Le': '2026-11-03T07:45:00Z'}).get_json()
    entree = JournalAudit.query.filter_by(table_nom='paiement', ligne_id=str(p['id'])).one()
    assert entree.auteur_nom == 'Admin Test'
    assert entree.saisi_hors_ligne_le.isoformat() == '2026-11-03T07:45:00'
    assert entree.changements['montant_total'] == [None, 20000.0]
    assert JournalAudit.query.filter_by(table_nom='ligne_paiement').count() == 1
