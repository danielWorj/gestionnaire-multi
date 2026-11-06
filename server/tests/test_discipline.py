"""Discipline : création répétable (synchronisation hors connexion) et
conflits, comme pour les notes."""


def _fiche(monde, **kw):
    body = {'inscription_id': monde.inscription_id, 'sequence_id': monde.sequence_id,
            'absences_justifiees': 1, 'absences_non_justifiees': 0, 'retards': 2, 'exclusions': 0,
            'observation': 'Bavard'}
    body.update(kw)
    return body


def test_creation_puis_renvoi_identique(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    rep = censeur.post('/api/disciplines/', json=_fiche(monde, version_base=None))
    assert rep.status_code == 201, rep.get_json()
    fiche = rep.get_json()
    assert fiche['version'] == 1
    rep = censeur.post('/api/disciplines/', json=_fiche(monde, version_base=None))
    assert rep.status_code == 200
    assert rep.get_json()['id'] == fiche['id']
    assert rep.get_json()['version'] == 1


def test_doublon_hors_ligne_signale_avec_auteur(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    censeur.post('/api/disciplines/', json=_fiche(monde, version_base=None))
    admin = connecter(monde.admin_compte)
    rep = admin.post('/api/disciplines/', json=_fiche(monde, retards=5, version_base=None))
    assert rep.status_code == 409
    data = rep.get_json()
    assert data['code'] == 'doublon'
    assert data['serveur']['retards'] == 2
    assert data['modification']['auteur']['nom'] == 'Censeur Test'


def test_conflit_puis_ecraser(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    fiche = censeur.post('/api/disciplines/', json=_fiche(monde, version_base=None)).get_json()
    admin = connecter(monde.admin_compte)
    assert admin.put(f"/api/disciplines/{fiche['id']}", json={'retards': 3, 'version_base': 1}).status_code == 200

    rep = censeur.put(f"/api/disciplines/{fiche['id']}", json={'retards': 4, 'version_base': 1})
    assert rep.status_code == 409
    assert rep.get_json()['code'] == 'conflit'
    assert rep.get_json()['modification']['auteur']['nom'] == 'Admin Test'

    rep = censeur.put(f"/api/disciplines/{fiche['id']}", json={'retards': 4, 'version_base': 1, 'forcer': True})
    assert rep.status_code == 200
    assert rep.get_json()['retards'] == 4
    assert rep.get_json()['version'] == 3


def test_post_avec_version_a_jour_met_a_jour(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    fiche = censeur.post('/api/disciplines/', json=_fiche(monde, version_base=None)).get_json()
    rep = censeur.post('/api/disciplines/', json=_fiche(monde, exclusions=1, version_base=fiche['version']))
    assert rep.status_code == 200
    assert rep.get_json()['exclusions'] == 1
