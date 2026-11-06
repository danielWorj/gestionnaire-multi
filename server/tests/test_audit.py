"""Journal d'audit : contenu des entrées, versionnage, atomicité (pas de
modification sans trace), secrets masqués, droits de consultation."""
import pytest

from extensions import db
from models.audit_models import JournalAudit
from models.evaluation_models import Note


def _note(monde, **kw):
    body = {'inscription_id': monde.inscription_id, 'matiere_classe_id': monde.mc_id,
            'sequence_id': monde.sequence_id, 'valeur': 12, 'absent': False}
    body.update(kw)
    return body


def _entrees(table, ligne_id=None):
    q = JournalAudit.query.filter_by(table_nom=table)
    if ligne_id is not None:
        q = q.filter_by(ligne_id=str(ligne_id))
    return q.order_by(JournalAudit.id).all()


def test_creation_journalisee_avec_auteur(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    rep = prof.post('/api/notes/', json=_note(monde))
    assert rep.status_code == 201, rep.get_json()
    note = rep.get_json()
    assert note['version'] == 1

    [entree] = _entrees('note', note['id'])
    assert entree.action == 'creation'
    assert entree.auteur_type == 'utilisateur'
    assert entree.auteur_id == monde.enseignant_compte['id']
    assert entree.auteur_nom == 'Prof Test'
    assert entree.auteur_role == 'Enseignant'
    assert entree.etablissement_id == monde.etab_id
    assert entree.version_ligne == 1
    assert entree.changements['valeur'] == [None, 12.0]
    assert 'version' not in entree.changements


def test_modification_incremente_version_et_trace_avant_apres(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    note = prof.post('/api/notes/', json=_note(monde)).get_json()

    rep = prof.put(f"/api/notes/{note['id']}", json={'valeur': 15.5})
    assert rep.status_code == 200
    assert rep.get_json()['version'] == 2

    # POST idempotent (synchronisation hors ligne) : même ligne, version 3.
    rep = prof.post('/api/notes/', json=_note(monde, absent=True))
    assert rep.status_code == 200
    assert rep.get_json()['id'] == note['id']
    assert rep.get_json()['version'] == 3

    creation, modif1, modif2 = _entrees('note', note['id'])
    assert modif1.action == 'modification'
    assert modif1.changements['valeur'] == [12.0, 15.5]
    assert modif1.version_ligne == 2
    assert modif2.changements['absent'] == [False, True]
    assert modif2.changements['valeur'] == [15.5, None]


def test_modification_sans_changement_ne_journalise_rien(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    note = prof.post('/api/notes/', json=_note(monde)).get_json()
    rep = prof.put(f"/api/notes/{note['id']}", json={'valeur': 12})
    assert rep.status_code == 200
    # saisie_le est rafraîchi par le service : c'est la seule différence.
    entrees = _entrees('note', note['id'])
    assert all(set(e.changements) <= {'valeur', 'absent', 'saisie_le', 'inscription_id', 'matiere_classe_id',
                                      'sequence_id', 'id'} for e in entrees)
    assert all('valeur' not in e.changements for e in entrees[1:])


def test_heure_de_saisie_hors_ligne_enregistree(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    rep = prof.post('/api/notes/', json=_note(monde), headers={'X-Saisi-Hors-Ligne-Le': '2026-11-02T08:15:00.000Z'})
    assert rep.status_code == 201
    [entree] = _entrees('note', rep.get_json()['id'])
    assert entree.saisi_hors_ligne_le.isoformat() == '2026-11-02T08:15:00'


def test_heure_hors_ligne_dans_le_futur_ignoree(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    rep = prof.post('/api/notes/', json=_note(monde), headers={'X-Saisi-Hors-Ligne-Le': '2099-01-01T00:00:00Z'})
    [entree] = _entrees('note', rep.get_json()['id'])
    assert entree.saisi_hors_ligne_le is None


def test_echec_du_journal_annule_la_modification(monde, connecter, monkeypatch):
    import services.audit_services as audit

    def panne(*_args, **_kwargs):
        raise RuntimeError('journal indisponible')

    monkeypatch.setattr(audit, '_entree', panne)
    prof = connecter(monde.enseignant_compte)
    rep = prof.post('/api/notes/', json=_note(monde))
    assert rep.status_code >= 500
    db.session.rollback()
    assert Note.query.count() == 0
    assert JournalAudit.query.filter_by(table_nom='note').count() == 0


def test_suppression_conserve_les_anciennes_valeurs(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    note = prof.post('/api/notes/', json=_note(monde, valeur=9)).get_json()
    assert prof.delete(f"/api/notes/{note['id']}").status_code == 200
    suppression = _entrees('note', note['id'])[-1]
    assert suppression.action == 'suppression'
    assert suppression.changements['valeur'] == [9.0, None]
    assert suppression.auteur_nom == 'Prof Test'


def test_connexion_seule_ne_pollue_pas_le_journal(monde, connecter):
    avant = JournalAudit.query.filter_by(table_nom='utilisateur', action='modification').count()
    connecter(monde.enseignant_compte)
    assert JournalAudit.query.filter_by(table_nom='utilisateur', action='modification').count() == avant


def test_secret_jamais_en_clair(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    rep = prof.post('/api/auth/change-password',
                    json={'ancien_pin': monde.enseignant_compte['pin_temporaire'], 'nouveau_pin': '8642'})
    assert rep.status_code == 200, rep.get_json()
    entree = _entrees('utilisateur', monde.enseignant_compte['id'])[-1]
    assert entree.changements['mot_de_passe_hash'] == ['••••••', '••••••']
    for e in JournalAudit.query.all():
        assert '8642' not in str(e.changements)
        assert monde.enseignant_compte['pin_temporaire'] not in str(e.changements.get('mot_de_passe_hash', ''))


def test_ecriture_hors_requete_attribuee_au_systeme(monde):
    from models.inscription_models import Eleve
    eleve = db.session.get(Eleve, monde.eleve_id)
    eleve.lieu_naissance = 'Douala'
    db.session.commit()
    assert eleve.version == 2
    entree = _entrees('eleve', monde.eleve_id)[-1]
    assert entree.auteur_type == 'systeme'
    assert entree.changements['lieu_naissance'] == ['Yaoundé', 'Douala']


def test_consultation_admin(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    note = prof.post('/api/notes/', json=_note(monde)).get_json()
    admin = connecter(monde.admin_compte)
    rep = admin.get(f"/api/audit/?table=note&ligne_id={note['id']}")
    assert rep.status_code == 200
    data = rep.get_json()
    assert data['total'] == 1
    assert data['items'][0]['auteur']['nom'] == 'Prof Test'


def test_consultation_censeur_limitee_au_pedagogique(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    prof.post('/api/notes/', json=_note(monde))
    censeur = connecter(monde.censeur_compte)
    data = censeur.get('/api/audit/?limite=200').get_json()
    assert data['total'] >= 1
    assert {e['table'] for e in data['items']} <= {'note', 'discipline', 'horaire'}


@pytest.mark.parametrize('compte', ['enseignant_compte'])
def test_consultation_refusee_aux_autres_roles(monde, connecter, compte):
    client = connecter(getattr(monde, compte))
    assert client.get('/api/audit/').status_code == 403


def test_journal_en_lecture_seule(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert admin.post('/api/audit/', json={}).status_code in (403, 405)
    assert admin.delete('/api/audit/').status_code in (403, 405)
