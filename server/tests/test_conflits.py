"""Protocole de conflits (synchronisation hors connexion) sur les notes."""


def _note(monde, **kw):
    body = {'inscription_id': monde.inscription_id, 'matiere_classe_id': monde.mc_id,
            'sequence_id': monde.sequence_id, 'valeur': 12, 'absent': False}
    body.update(kw)
    return body


def test_creation_puis_doublon_avec_auteur(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    assert prof.post('/api/notes/', json=_note(monde, version_base=None)).status_code == 201

    # Saisie hors ligne d'une AUTRE valeur, en croyant la note inexistante.
    rep = prof.post('/api/notes/', json=_note(monde, valeur=8, version_base=None))
    assert rep.status_code == 409
    data = rep.get_json()
    assert data['code'] == 'doublon'
    assert data['serveur']['valeur'] == 12.0
    assert data['modification']['auteur']['nom'] == 'Prof Test'
    assert data['modification']['action'] == 'creation'


def test_renvoi_identique_n_est_pas_un_conflit(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    premiere = prof.post('/api/notes/', json=_note(monde, version_base=None)).get_json()
    rep = prof.post('/api/notes/', json=_note(monde, version_base=None))
    assert rep.status_code == 200
    assert rep.get_json()['id'] == premiere['id']
    assert rep.get_json()['version'] == premiere['version']


def test_version_perimee_puis_ecraser(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    note = prof.post('/api/notes/', json=_note(monde, version_base=None)).get_json()
    # Modification concurrente (autre appareil) : version 2.
    assert prof.put(f"/api/notes/{note['id']}", json={'valeur': 14, 'version_base': 1}).status_code == 200

    # La saisie hors ligne basée sur la version 1 arrive ensuite.
    rep = prof.put(f"/api/notes/{note['id']}", json={'valeur': 9, 'version_base': 1})
    assert rep.status_code == 409
    data = rep.get_json()
    assert data['code'] == 'conflit'
    assert data['serveur']['valeur'] == 14.0
    assert data['serveur']['version'] == 2
    assert data['modification']['changements']['valeur'] == [12.0, 14.0]

    # L'utilisateur choisit d'écraser.
    rep = prof.put(f"/api/notes/{note['id']}", json={'valeur': 9, 'version_base': 1, 'forcer': True})
    assert rep.status_code == 200
    assert rep.get_json()['valeur'] == 9.0
    assert rep.get_json()['version'] == 3


def test_version_a_jour_passe_sans_conflit(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    note = prof.post('/api/notes/', json=_note(monde, version_base=None)).get_json()
    rep = prof.post('/api/notes/', json=_note(monde, valeur=16, version_base=note['version']))
    assert rep.status_code == 200
    assert rep.get_json()['valeur'] == 16.0


def test_version_jamais_modifiable_par_le_client(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    note = prof.post('/api/notes/', json=_note(monde)).get_json()
    rep = prof.put(f"/api/notes/{note['id']}", json={'valeur': 13, 'version': 1})
    assert rep.get_json()['version'] == 2
    rep = prof.put(f"/api/notes/{note['id']}", json={'valeur': 13.5, 'version': 99})
    assert rep.get_json()['version'] == 3


def test_sans_protocole_comportement_historique(monde, connecter):
    """Clients sans version_base (outils internes) : pas de contrôle."""
    prof = connecter(monde.enseignant_compte)
    prof.post('/api/notes/', json=_note(monde))
    rep = prof.post('/api/notes/', json=_note(monde, valeur=5))
    assert rep.status_code == 200
    assert rep.get_json()['valeur'] == 5.0


def test_conflit_n_ecrit_rien_et_ne_journalise_rien(monde, connecter):
    from models.audit_models import JournalAudit
    prof = connecter(monde.enseignant_compte)
    note = prof.post('/api/notes/', json=_note(monde, version_base=None)).get_json()
    avant = JournalAudit.query.filter_by(table_nom='note').count()
    rep = prof.put(f"/api/notes/{note['id']}", json={'valeur': 3, 'version_base': 0})
    assert rep.status_code == 409
    assert JournalAudit.query.filter_by(table_nom='note').count() == avant


def test_put_complet_identique_n_ecrit_rien(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    note = prof.post('/api/notes/', json=_note(monde)).get_json()
    rep = prof.put(f"/api/notes/{note['id']}", json=_note(monde, version_base=1))
    assert rep.status_code == 200
    assert rep.get_json()['version'] == 1
