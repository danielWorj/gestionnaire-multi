"""État de solvabilité (GET /api/paiements/solvabilite) : exigible à la date
d'arrêté, insolvabilité, ancienneté des retards, suspendus inclus, élèves
sortis à part, classes sans échéancier hors taux, situation reconstituée à
une date passée (annulations postérieures), mouvements de caisse."""
from datetime import date, datetime, timedelta

import pytest

from extensions import db
from models.inscription_models import Eleve, Inscription
from models.paiements_models import Paiement, TrancheClasse
from models.structure_models import Classe

AUJ = date.today()


def _tranche(monde, libelle, ordre, montant, date_limite, classe_id=None):
    t = TrancheClasse(classe_id=classe_id or monde.classe_id, annee_scolaire_id=monde.annee_id,
                      libelle=libelle, ordre=ordre, montant_attendu=montant, date_limite=date_limite)
    db.session.add(t)
    db.session.commit()
    return t.id


def _eleve(monde, matricule, nom, statut='Actif', classe_id=None):
    e = Eleve(etablissement_id=monde.etab_id, matricule=matricule, nom=nom, prenom='X', sexe='M',
              lieu_naissance='Yaoundé', parent_id=monde.parent_id)
    db.session.add(e)
    db.session.flush()
    i = Inscription(eleve_id=e.id, classe_id=classe_id or monde.classe_id, annee_scolaire_id=monde.annee_id,
                    date_inscription=date(2026, 9, 1), statut=statut)
    db.session.add(i)
    db.session.commit()
    return i.id


def _payer(api, monde, inscription_id, tranche_id, montant, mode='ESPECES', le=None):
    rep = api.post('/api/paiements/', json={
        'inscription_id': inscription_id, 'parent_id': monde.parent_id, 'montant_total': montant,
        'mode_paiement': mode, 'lignes': [{'tranche_classe_id': tranche_id, 'montant_verse': montant}]})
    assert rep.status_code == 201, rep.get_json()
    pid = rep.get_json()['id']
    if le:
        p = db.session.get(Paiement, pid)
        p.date_paiement = datetime.combine(le, datetime.min.time()) + timedelta(hours=10)
        db.session.commit()
    return pid


def _rapport(api, **params):
    rep = api.get('/api/paiements/solvabilite', query_string=params)
    assert rep.status_code == 200, rep.get_json()
    return rep.get_json()


@pytest.fixture()
def admin(monde, connecter):
    return connecter(monde.admin_compte)


def test_rien_d_echu_rien_paye_est_solvable(monde, admin):
    _tranche(monde, 'T1', 1, 50000, AUJ + timedelta(days=20))
    r = _rapport(admin)
    g = r['global']
    assert g['effectif'] == 1 and g['solvables'] == 1 and g['insolvables'] == 0
    assert g['exigible'] == 0 and g['impaye_exigible'] == 0
    assert g['attendu'] == 50000 and g['reste_annuel'] == 50000
    assert g['taux_recouvrement_exigible'] is None  # rien d'exigible : non applicable, pas 0 %
    assert r['classes'][0]['tranches'][0]['echue'] is False


def test_tranche_echue_impayee_rend_insolvable_avec_anciennete(monde, admin):
    t1 = _tranche(monde, 'Inscription', 1, 10000, None)
    _tranche(monde, 'T1', 2, 40000, AUJ - timedelta(days=45))
    _tranche(monde, 'T2', 3, 40000, AUJ + timedelta(days=30))
    _payer(admin, monde, monde.inscription_id, t1, 10000)
    r = _rapport(admin)
    g = r['global']
    assert g['insolvables'] == 1 and g['pct_insolvables'] == 100.0
    assert g['exigible'] == 50000 and g['verse_sur_exigible'] == 10000 and g['impaye_exigible'] == 40000
    assert g['taux_recouvrement_exigible'] == 20.0
    eleve = r['insolvables'][0]
    assert eleve['jours_retard'] == 45
    assert [t['libelle'] for t in eleve['tranches_en_retard']] == ['T1']
    assert eleve['parent']['telephone'] == '600000000'
    buckets = {b['code']: b for b in r['anciennete']}
    assert buckets['31_60'] == {'code': '31_60', 'libelle': '31 à 60 jours', 'nb_eleves': 1, 'montant': 40000}


def test_retard_compte_au_plus_tot_depuis_l_inscription(monde, admin):
    """Élève inscrit le 1er septembre, tranche échue avant : le retard court
    depuis l'inscription, pas depuis l'échéance."""
    _tranche(monde, 'T1', 1, 40000, date(2026, 8, 1))
    eleve = _rapport(admin)['insolvables'][0]
    assert eleve['jours_retard'] == (AUJ - date(2026, 9, 1)).days


def test_versement_sur_tranche_a_venir_est_une_avance(monde, admin):
    _tranche(monde, 'T1', 1, 30000, AUJ - timedelta(days=5))
    t2 = _tranche(monde, 'T2', 2, 30000, AUJ + timedelta(days=30))
    _payer(admin, monde, monde.inscription_id, t2, 30000)
    g = _rapport(admin)['global']
    assert g['insolvables'] == 1 and g['avance'] == 30000 and g['impaye_exigible'] == 30000


def test_suspendu_compte_radie_a_part(monde, admin):
    _tranche(monde, 'T1', 1, 20000, AUJ - timedelta(days=10))
    _eleve(monde, 'M002', 'Suspendu', statut='Suspendu')
    _eleve(monde, 'M003', 'Radie', statut='Radié')
    r = _rapport(admin)
    assert r['global']['effectif'] == 2 and r['global']['suspendus'] == 1
    assert r['global']['insolvables'] == 2
    assert r['creances_sortis']['nb'] == 1 and r['creances_sortis']['montant'] == 20000
    assert r['creances_sortis']['eleves'][0]['matricule'] == 'M003'


def test_classe_sans_echeancier_hors_taux(monde, admin):
    _tranche(monde, 'T1', 1, 20000, AUJ - timedelta(days=10))
    autre = Classe(etablissement_id=monde.etab_id, cycle_id=db.session.get(Classe, monde.classe_id).cycle_id, option='B')
    db.session.add(autre)
    db.session.commit()
    _eleve(monde, 'M010', 'SansEch', classe_id=autre.id)
    r = _rapport(admin)
    g = r['global']
    assert g['effectif'] == 2 and g['sans_echeancier'] == 1 and g['effectif_evaluable'] == 1
    assert g['pct_insolvables'] == 100.0  # et non 50 % : l'élève sans échéancier n'est pas évaluable
    classe_b = next(c for c in r['classes'] if c['classe_id'] == autre.id)
    assert classe_b['a_echeancier'] is False and classe_b['pct_insolvables'] is None


def test_situation_a_une_date_passee(monde, admin):
    t1 = _tranche(monde, 'T1', 1, 50000, AUJ - timedelta(days=30))
    pid = _payer(admin, monde, monde.inscription_id, t1, 50000, le=AUJ - timedelta(days=20))
    assert admin.post(f'/api/paiements/{pid}/annuler', json={'motif_annulation': 'Chèque impayé'}).status_code == 200

    # Aujourd'hui : le paiement est annulé, l'élève est insolvable.
    assert _rapport(admin)['global']['insolvables'] == 1
    # Il y a 10 jours, le paiement (annulé depuis) était encore valide.
    passe = _rapport(admin, date=(AUJ - timedelta(days=10)).isoformat())
    assert passe['global']['insolvables'] == 0 and passe['global']['verse'] == 50000
    assert passe['mouvements']['nb_annulations'] == 0
    # Il y a 25 jours : la tranche était déjà échue, mais rien n'était encore versé.
    avant = _rapport(admin, date=(AUJ - timedelta(days=25)).isoformat())
    assert avant['global']['verse'] == 0 and avant['global']['insolvables'] == 1


def test_mouvements_de_caisse_et_annulations(monde, admin):
    t1 = _tranche(monde, 'T1', 1, 100000, AUJ + timedelta(days=30))
    _payer(admin, monde, monde.inscription_id, t1, 30000, mode='ESPECES')
    _payer(admin, monde, monde.inscription_id, t1, 20000, mode='MOBILE_MONEY')
    pid = _payer(admin, monde, monde.inscription_id, t1, 5000, mode='ESPECES')
    admin.post(f'/api/paiements/{pid}/annuler', json={'motif_annulation': 'Erreur de saisie'})
    m = _rapport(admin, du=AUJ.isoformat())['mouvements']
    assert m['nb_encaissements'] == 2 and m['montant_encaisse'] == 50000
    assert {x['mode']: x['montant'] for x in m['par_mode']} == {'ESPECES': 30000, 'MOBILE_MONEY': 20000}
    assert m['par_agent'][0]['agent'] == 'Admin Test'
    assert m['nb_annulations'] == 1 and m['montant_annule'] == 5000
    assert m['annulations'][0]['motif'] == 'Erreur de saisie'
    assert m['annulations'][0]['annule_par'] == 'Admin Test'


def test_filtre_classe(monde, admin):
    _tranche(monde, 'T1', 1, 20000, AUJ - timedelta(days=1))
    r = _rapport(admin, classe_id=monde.classe_id)
    assert len(r['classes']) == 1 and len(r['eleves']) == 1
    assert r['eleves'][0]['solvabilite'] == 'INSOLVABLE'


def test_parametres_invalides(monde, admin):
    assert admin.get('/api/paiements/solvabilite', query_string={'date': (AUJ + timedelta(days=1)).isoformat()}).status_code == 400
    assert admin.get('/api/paiements/solvabilite', query_string={'date': 'hier'}).status_code == 400
    assert admin.get('/api/paiements/solvabilite', query_string={'du': AUJ.isoformat(), 'date': (AUJ - timedelta(days=1)).isoformat()}).status_code == 400
    assert admin.get('/api/paiements/solvabilite', query_string={'annee_scolaire_id': 9999}).status_code == 404


def test_reserve_aux_roles_financiers(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    assert censeur.get('/api/paiements/solvabilite').status_code == 403
