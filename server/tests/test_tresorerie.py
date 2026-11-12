"""Trésorerie : fonds (catégories d'entrée) alimentés par la scolarité et les
entrées manuelles, dépenses ventilées sur les fonds, comptes, transferts,
annulations et états."""
import pytest

from extensions import db
from models.paiements_models import TrancheClasse


@pytest.fixture()
def admin(monde, connecter):
    return connecter(monde.admin_compte)


def _categories(admin, type_categorie):
    return {c['libelle']: c['id'] for c in admin.get(f'/api/tresorerie/categories?type={type_categorie}').get_json()}


def _comptes(admin):
    return {c['type']: c['id'] for c in admin.get('/api/tresorerie/comptes').get_json() if c['par_defaut']}


def _creer_categorie(admin, type_categorie, libelle):
    rep = admin.post('/api/tresorerie/categories', json={'type': type_categorie, 'libelle': libelle})
    assert rep.status_code == 201, rep.get_json()
    return rep.get_json()['id']


def _tranche(monde, libelle='Tranche 1', ordre=1, montant=50000, categorie=None):
    t = TrancheClasse(classe_id=monde.classe_id, annee_scolaire_id=monde.annee_id, libelle=libelle, ordre=ordre,
                      montant_attendu=montant, categorie_entree_id=categorie)
    db.session.add(t)
    db.session.commit()
    return t.id


def _payer(admin, monde, tranche, montant, mode='ESPECES'):
    rep = admin.post('/api/paiements/', json={
        'inscription_id': monde.inscription_id, 'parent_id': monde.parent_id, 'montant_total': montant,
        'mode_paiement': mode, 'lignes': [{'tranche_classe_id': tranche, 'montant_verse': montant}]})
    assert rep.status_code == 201, rep.get_json()
    return rep.get_json()


def _synthese(admin):
    rep = admin.get('/api/tresorerie/synthese')
    assert rep.status_code == 200, rep.get_json()
    return rep.get_json()


def _fonds(synthese):
    return {f['libelle']: f['solde'] for f in synthese['fonds']}


def _soldes_comptes(synthese):
    return {c['type']: c['solde'] for c in synthese['comptes'] if c['par_defaut']}


def test_initialisation_et_paiement_dans_le_fonds_par_defaut(monde, admin):
    entrees = _categories(admin, 'ENTREE')
    assert list(entrees) == ['Scolarité']
    assert set(_comptes(admin)) == {'CAISSE', 'BANQUE', 'MOBILE_MONEY'}

    tranche = _tranche(monde)
    _payer(admin, monde, tranche, 30000, mode='ESPECES')
    _payer(admin, monde, tranche, 5000, mode='MOBILE_MONEY')

    s = _synthese(admin)
    assert s['total_entrees'] == 35000
    assert _fonds(s)['Scolarité'] == 35000
    comptes = _soldes_comptes(s)
    assert comptes['CAISSE'] == 30000 and comptes['MOBILE_MONEY'] == 5000
    assert s['solde_global'] == 35000
    assert s['entrees_par_categorie'][0]['dont_scolarite'] == 35000


def test_tranche_rattachee_a_un_fonds_et_controle_de_categorie(monde, admin):
    apee = _creer_categorie(admin, 'ENTREE', 'APEE')
    sortie = _creer_categorie(admin, 'SORTIE', 'Fournitures')

    rep = admin.post('/api/tranches-classe/', json={
        'classe_id': monde.classe_id, 'annee_scolaire_id': monde.annee_id, 'libelle': 'APEE', 'ordre': 1,
        'montant_attendu': 10000, 'categorie_entree_id': sortie})
    assert rep.status_code == 400  # une catégorie de SORTIE ne peut pas recevoir de paiements

    rep = admin.post('/api/tranches-classe/', json={
        'classe_id': monde.classe_id, 'annee_scolaire_id': monde.annee_id, 'libelle': 'APEE', 'ordre': 1,
        'montant_attendu': 10000, 'categorie_entree_id': apee})
    assert rep.status_code == 201, rep.get_json()
    _payer(admin, monde, rep.get_json()['id'], 10000)

    fonds = _fonds(_synthese(admin))
    assert fonds['APEE'] == 10000 and fonds['Scolarité'] == 0


def test_depense_ventilee_sur_deux_fonds(monde, admin):
    apee = _creer_categorie(admin, 'ENTREE', 'APEE')
    salaires = _creer_categorie(admin, 'SORTIE', 'Salaires vacataires')
    scolarite = _categories(admin, 'ENTREE')['Scolarité']
    comptes = _comptes(admin)
    _payer(admin, monde, _tranche(monde, montant=100000), 100000)
    _payer(admin, monde, _tranche(monde, 'APEE', 2, 20000, apee), 20000)

    rep = admin.post('/api/tresorerie/mouvements', json={
        'sens': 'SORTIE', 'montant': 50000, 'libelle': 'Vacations octobre', 'categorie_id': salaires,
        'compte_id': comptes['CAISSE'], 'tiers': 'M. Ndzana',
        'ventilation': [{'categorie_id': scolarite, 'montant': 40000}, {'categorie_id': apee, 'montant': 10000}]})
    assert rep.status_code == 201, rep.get_json()
    assert len(rep.get_json()['ventilation']) == 2

    s = _synthese(admin)
    assert _fonds(s) == {'Scolarité': 60000, 'APEE': 10000}
    assert s['sorties_par_categorie'] == [{'categorie_id': salaires, 'libelle': 'Salaires vacataires', 'montant': 50000}]
    assert s['resultat'] == 70000
    # La somme des fonds est toujours égale à la somme des comptes.
    assert sum(f['solde'] for f in s['fonds']) == s['solde_global'] == 70000


def test_ventilation_doit_egaler_le_montant(monde, admin):
    sortie = _creer_categorie(admin, 'SORTIE', 'Fournitures')
    scolarite = _categories(admin, 'ENTREE')['Scolarité']
    rep = admin.post('/api/tresorerie/mouvements', json={
        'sens': 'SORTIE', 'montant': 10000, 'libelle': 'Craies', 'categorie_id': sortie,
        'compte_id': _comptes(admin)['CAISSE'], 'ventilation': [{'categorie_id': scolarite, 'montant': 8000}],
        'forcer': True})
    assert rep.status_code == 400
    assert 'répartition' in rep.get_json()['erreur']


def test_solde_insuffisant_avertit_puis_enregistrer_quand_meme(monde, admin):
    sortie = _creer_categorie(admin, 'SORTIE', 'Fournitures')
    scolarite = _categories(admin, 'ENTREE')['Scolarité']
    _payer(admin, monde, _tranche(monde), 5000)
    body = {'sens': 'SORTIE', 'montant': 8000, 'libelle': 'Rames de papier', 'categorie_id': sortie,
            'compte_id': _comptes(admin)['CAISSE'], 'categorie_entree_id': scolarite}

    rep = admin.post('/api/tresorerie/mouvements', json=body)
    assert rep.status_code == 409
    data = rep.get_json()
    assert data['code'] == 'solde_insuffisant'
    assert {a['type'] for a in data['avertissements']} == {'fonds', 'compte'}

    rep = admin.post('/api/tresorerie/mouvements', json={**body, 'forcer': True})
    assert rep.status_code == 201, rep.get_json()
    assert _fonds(_synthese(admin))['Scolarité'] == -3000


def test_entree_manuelle_transfert_et_annulation(monde, admin):
    dons = _creer_categorie(admin, 'ENTREE', 'Dons')
    comptes = _comptes(admin)
    rep = admin.post('/api/tresorerie/mouvements', json={
        'sens': 'ENTREE', 'montant': 200000, 'libelle': 'Don de la mairie', 'categorie_id': dons,
        'compte_id': comptes['CAISSE']})
    assert rep.status_code == 201, rep.get_json()
    don_id = rep.get_json()['id']

    rep = admin.post('/api/tresorerie/mouvements', json={
        'sens': 'TRANSFERT', 'montant': 150000, 'libelle': 'Dépôt en banque', 'compte_id': comptes['CAISSE'],
        'compte_destination_id': comptes['BANQUE']})
    assert rep.status_code == 201, rep.get_json()

    s = _synthese(admin)
    assert _soldes_comptes(s) == {'CAISSE': 50000, 'BANQUE': 150000, 'MOBILE_MONEY': 0}
    assert _fonds(s)['Dons'] == 200000
    assert s['total_sorties'] == 0  # un transfert n'est pas une dépense

    journal = admin.get('/api/tresorerie/journal').get_json()['lignes']
    assert {l['sens'] for l in journal} == {'ENTREE', 'TRANSFERT'}

    assert admin.post(f'/api/tresorerie/mouvements/{don_id}/annuler', json={}).status_code == 400
    rep = admin.post(f'/api/tresorerie/mouvements/{don_id}/annuler', json={'motif_annulation': 'Saisie en double'})
    assert rep.status_code == 200 and rep.get_json()['statut'] == 'ANNULE'
    assert _fonds(_synthese(admin))['Dons'] == 0
    # Jamais de suppression d'une opération : elle reste au journal, annulée.
    assert admin.delete(f'/api/tresorerie/mouvements/{don_id}').status_code == 405
    journal = admin.get(f"/api/tresorerie/journal?categorie_id={dons}").get_json()['lignes']
    assert [l['statut'] for l in journal] == ['ANNULE']


def test_categorie_utilisee_non_supprimable(monde, admin):
    apee = _creer_categorie(admin, 'ENTREE', 'APEE')
    _tranche(monde, categorie=apee)
    assert admin.delete(f'/api/tresorerie/categories/{apee}').status_code == 400
    assert admin.put(f'/api/tresorerie/categories/{apee}', json={'actif': False}).status_code == 200
    defaut = _categories(admin, 'ENTREE')['Scolarité']
    assert admin.delete(f'/api/tresorerie/categories/{defaut}').status_code == 400


def test_acces_reserve_aux_finances(monde, connecter):
    enseignant = connecter(monde.enseignant_compte)
    assert enseignant.get('/api/tresorerie/synthese').status_code == 403


def test_operation_auditee(monde, admin):
    from models.audit_models import JournalAudit
    sortie = _creer_categorie(admin, 'ENTREE', 'Cantine')
    admin.post('/api/tresorerie/mouvements', json={
        'sens': 'ENTREE', 'montant': 1000, 'libelle': 'Tickets', 'categorie_id': sortie,
        'compte_id': _comptes(admin)['CAISSE']})
    entree = JournalAudit.query.filter_by(table_nom='mouvement_tresorerie').first()
    assert entree is not None and entree.auteur_nom == 'Admin Test'


# ── Hors connexion ─────────────────────────────────────────────────────────

def _entree_body(admin, **kw):
    dons = _categories(admin, 'ENTREE').get('Dons') or _creer_categorie(admin, 'ENTREE', 'Dons')
    body = {'sens': 'ENTREE', 'montant': 10000, 'libelle': 'Don', 'categorie_id': dons,
            'compte_id': _comptes(admin)['CAISSE'], 'date_operation': '2026-10-01'}
    body.update(kw)
    return body


def test_renvoi_hors_connexion_n_enregistre_pas_deux_fois(monde, admin):
    from models.tresorerie_models import MouvementTresorerie
    body = _entree_body(admin, cle_idempotence='appareil-1-xyz', version_base=None)
    premier = admin.post('/api/tresorerie/mouvements', json=body, headers={'X-Saisi-Hors-Ligne-Le': '2026-10-01T08:00:00Z'})
    assert premier.status_code == 201, premier.get_json()
    second = admin.post('/api/tresorerie/mouvements', json=body)
    assert second.status_code == 200 and second.get_json()['id'] == premier.get_json()['id']
    assert MouvementTresorerie.query.count() == 1


def test_doublon_probable_puis_enregistrer_quand_meme_tresorerie(monde, admin):
    assert admin.post('/api/tresorerie/mouvements', json=_entree_body(admin, cle_idempotence='a', version_base=None)).status_code == 201
    rep = admin.post('/api/tresorerie/mouvements', json=_entree_body(admin, cle_idempotence='b', version_base=None))
    assert rep.status_code == 409 and rep.get_json()['code'] == 'doublon'
    assert rep.get_json()['modification']['auteur']['nom'] == 'Admin Test'
    rep = admin.post('/api/tresorerie/mouvements', json=_entree_body(admin, cle_idempotence='b', version_base=None, forcer=True))
    assert rep.status_code == 201


def test_annulation_rejouee_sans_erreur(monde, admin):
    mid = admin.post('/api/tresorerie/mouvements', json=_entree_body(admin)).get_json()['id']
    for _ in range(2):
        rep = admin.post(f'/api/tresorerie/mouvements/{mid}/annuler', json={'motif_annulation': 'Erreur'})
        assert rep.status_code == 200 and rep.get_json()['statut'] == 'ANNULE'


# ── Import ─────────────────────────────────────────────────────────────────

def _bloc(entetes, lignes):
    return {'source': 'cahier.xlsx', 'entetes': entetes, 'lignes': lignes}


def test_import_cahier_de_caisse_recettes_depenses(monde, admin):
    _payer(admin, monde, _tranche(monde, montant=100000), 100000)
    bloc = _bloc(['Date', 'Libellé', 'Rubrique', 'Recettes', 'Dépenses', 'Fonds'], [
        ['01/10/2026', 'Don de la mairie', 'Dons', '200 000', '', ''],
        ['02/10/2026', 'Achat de craies', 'Fournitures', '', '15.000', ''],
        ['03/10/2026', 'Vacations', 'Salaires', '', '50000', 'Scolarité:40000; Dons:10000'],
        ['04/10/2026', 'Ligne sans montant', 'Divers', '', '', ''],
    ])
    rep = admin.post('/api/import/tresorerie/traiter', json={'blocs': [bloc]})
    assert rep.status_code == 200, rep.get_json()
    data = rep.get_json()
    assert data['resume']['nouveaux'] == 3 and data['resume']['erreurs'] == 1
    assert data['resume']['total_entrees'] == 200000 and data['resume']['total_sorties'] == 65000
    assert data['resume']['categories_nouvelles'] == 3  # Dons, Fournitures, Salaires

    rep = admin.post('/api/import/tresorerie/traiter', json={'blocs': [bloc], 'valider': True})
    assert rep.status_code == 200, rep.get_json()
    assert rep.get_json()['bilan'] == {'entrees_creees': 1, 'depenses_creees': 2, 'categories_creees': 3}

    s = _synthese(admin)
    assert _fonds(s) == {'Scolarité': 100000 - 15000 - 40000, 'Dons': 200000 - 10000}
    assert sum(f['solde'] for f in s['fonds']) == s['solde_global']

    # Réimport du même fichier : rien n'est doublé.
    data = admin.post('/api/import/tresorerie/traiter', json={'blocs': [bloc]}).get_json()
    assert data['resume']['nouveaux'] == 0 and data['resume']['existants'] == 3


def test_import_type_montant_transfert_et_comptes(monde, admin):
    bloc = _bloc(['Date', 'Type', 'Montant', 'Libellé', 'Compte', 'Vers'], [
        ['2026-10-05', 'Entrée', '300000', 'Report de solde', 'Caisse', ''],
        ['2026-10-06', 'Transfert', '250000', 'Dépôt en banque', 'Espèces', 'Banque'],
        ['2026-10-07', 'Transfert', '1000', 'Sans destination', 'Caisse', ''],
        ['2026-10-08', 'Entrée', '1000', 'Compte inconnu', 'Coffre secret', ''],
    ])
    data = admin.post('/api/import/tresorerie/traiter', json={'blocs': [bloc], 'valider': True}).get_json()
    assert data['resume']['nouveaux'] == 2 and data['resume']['erreurs'] == 2
    assert _soldes_comptes(_synthese(admin)) == {'CAISSE': 50000, 'BANQUE': 250000, 'MOBILE_MONEY': 0}


def test_import_refuse_au_role_non_financier(monde, connecter):
    rep = connecter(monde.enseignant_compte).post('/api/import/tresorerie/traiter', json={'blocs': []})
    assert rep.status_code == 403


def test_modele_import_tresorerie(monde, admin):
    rep = admin.get('/api/import/tresorerie/modele')
    assert rep.status_code == 200 and rep.data[:2] == b'PK'
