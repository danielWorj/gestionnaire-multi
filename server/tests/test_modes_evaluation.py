"""Modes d'évaluation (Lycée, Collège, Institut) : choix et verrouillage par
année scolaire, saisie des évaluations CC/DS/Ev. Tr., calcul de la note de
séquence (bulletin, procès-verbal, avancement de la saisie)."""
from decimal import Decimal

import pytest

from extensions import db
from models.evaluation_models import Note
from models.structure_models import AnneeScolaire, Etablissement
from services.bulletin_services import construire_bulletins
from services.evaluation_services import notes_saisies_par_mc
from services.pv_services import construire_pv
from models.structure_models import Sequence


def _mode(monde, mode):
    db.session.get(AnneeScolaire, monde.annee_id).mode_evaluation = mode
    db.session.commit()


def _saisir(prof, monde, composante=None, valeur=None, absent=False):
    corps = {'inscription_id': monde.inscription_id, 'matiere_classe_id': monde.mc_id,
             'sequence_id': monde.sequence_id, 'valeur': valeur, 'absent': absent}
    if composante:
        corps['composante'] = composante
    return prof.post('/api/notes/', json=corps)


def _bulletin(monde, periode=None):
    data = construire_bulletins(db.session.get(Etablissement, monde.etab_id), monde.classe_id, monde.annee_id,
                                periode or f'seq:{monde.sequence_id}')
    return data, data['bulletins'][0]['groupes'][0]['lignes'][0]


def _pv(monde):
    pv = construire_pv(db.session.get(Etablissement, monde.etab_id), monde.classe_id, monde.annee_id,
                       monde.sequence_id, 'alphabetique')
    return pv['eleves'][0]['cellules'][0]


# --- Lycée : comportement historique inchangé --------------------------------

def test_lycee_inchange(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    rep = _saisir(prof, monde, valeur=12.5)
    assert rep.status_code == 201, rep.get_json()
    assert rep.get_json()['composante'] == 'note'
    # Une évaluation CC n'a pas de sens en mode Lycée.
    assert _saisir(prof, monde, 'cc', 10).status_code == 400

    data, ligne = _bulletin(monde)
    assert [c['libelle'] for c in data['colonnes_notes']] == ['SEQ1']
    assert ligne['cellules'] == [12.5] and ligne['moyenne'] == 12.5
    assert _pv(monde)['note'] == 12.5


# --- Collège : CC 30 % + DS 70 % ---------------------------------------------

def test_college_calcul_et_affichage(monde, connecter):
    _mode(monde, 'college')
    prof = connecter(monde.enseignant_compte)
    # La composante est obligatoire et limitée au mode.
    assert _saisir(prof, monde, valeur=12).status_code == 400
    assert _saisir(prof, monde, 'evtr', 12).status_code == 400

    assert _saisir(prof, monde, 'cc', 11).status_code == 201
    # DS pas encore saisi : compte 0 -> 0,3 × 11.
    _data, ligne = _bulletin(monde)
    assert ligne['moyenne'] == pytest.approx(3.3)

    assert _saisir(prof, monde, 'ds', 9).status_code == 201
    data, ligne = _bulletin(monde)
    assert ligne['moyenne'] == pytest.approx(0.3 * 11 + 0.7 * 9)
    # Modèle « Original » du Collège : CC, DS puis la note de la séquence.
    assert [c['libelle'] for c in data['colonnes_notes']] == ['CC N°1', 'DS N°1', 'Note N°1']
    assert data['colonne_moyenne'] is True
    assert ligne['cellules'] == [11.0, 9.0, pytest.approx(9.6)]
    assert _pv(monde)['note'] == pytest.approx(9.6)


def test_college_absence_compte_zero(monde, connecter):
    _mode(monde, 'college')
    prof = connecter(monde.enseignant_compte)
    assert _saisir(prof, monde, 'cc', absent=True).status_code == 201
    assert _saisir(prof, monde, 'ds', 10).status_code == 201
    _data, ligne = _bulletin(monde)
    assert ligne['moyenne'] == pytest.approx(7.0)
    assert ligne['cellules'] == ['ABS', 10.0, pytest.approx(7.0)]


def test_college_rien_saisi_non_classe(monde):
    _mode(monde, 'college')
    _data, ligne = _bulletin(monde)
    assert ligne['classe'] is False


# --- Institut : (CC + DS + Ev. Tr.) / 3, comme le bulletin papier ------------

def test_institut_moyenne_simple(monde, connecter):
    _mode(monde, 'institut')
    prof = connecter(monde.enseignant_compte)
    for composante, valeur in (('cc', 11), ('ds', 9), ('evtr', 8)):
        assert _saisir(prof, monde, composante, valeur).status_code == 201
    data, ligne = _bulletin(monde, f'tri:{monde.trimestre_id}')
    assert ligne['moyenne'] == 9.33              # 28 / 3 tronqué : 09.33 sur le bulletin papier
    assert [c['libelle'] for c in data['colonnes_notes']] == ['CC N°1', 'DS N°1', 'Ev. Tr. N°1']
    # Bulletin annuel : une colonne par séquence (note calculée).
    data, ligne = _bulletin(monde, 'annuel')
    assert [c['libelle'] for c in data['colonnes_notes']] == ['SEQ1']
    assert ligne['cellules'][0] == 9.33
    assert _pv(monde)['note_fmt'] == '9,33'


def test_avancement_eleve_complet_seulement(monde, connecter):
    _mode(monde, 'college')
    prof = connecter(monde.enseignant_compte)
    annee = db.session.get(AnneeScolaire, monde.annee_id)
    sequence = db.session.get(Sequence, monde.sequence_id)
    _saisir(prof, monde, 'cc', 12)
    assert notes_saisies_par_mc([monde.mc_id], sequence, annee).get(monde.mc_id, 0) == 0
    _saisir(prof, monde, 'ds', 12)
    assert notes_saisies_par_mc([monde.mc_id], sequence, annee)[monde.mc_id] == 1


def test_composante_non_modifiable(monde, connecter):
    _mode(monde, 'college')
    prof = connecter(monde.enseignant_compte)
    note_id = _saisir(prof, monde, 'cc', 12).get_json()['id']
    assert prof.put(f'/api/notes/{note_id}', json={'composante': 'ds', 'valeur': 13}).status_code == 400
    rep = prof.put(f'/api/notes/{note_id}', json={'valeur': 13})
    assert rep.status_code == 200 and rep.get_json()['composante'] == 'cc'


# --- Mode par année : défaut, verrouillage -----------------------------------

def test_mode_annee_defaut_et_verrouillage(monde, connecter):
    admin = connecter(monde.admin_compte)
    db.session.get(Etablissement, monde.etab_id).mode_evaluation = 'institut'
    db.session.commit()

    # Nouvelle année : mode de l'établissement par défaut.
    rep = admin.post('/api/annees-scolaires/', json={'libelle': '2027-2028'})
    assert rep.status_code == 201, rep.get_json()
    assert rep.get_json()['mode_evaluation'] == 'institut'
    assert admin.post('/api/annees-scolaires/', json={'libelle': '2028-2029', 'mode_evaluation': 'x'}).status_code == 400

    # Année sans note : mode modifiable.
    rep = admin.put(f'/api/annees-scolaires/{monde.annee_id}', json={'mode_evaluation': 'college'})
    assert rep.status_code == 200 and rep.get_json()['mode_verrouille'] is False

    # Première note : mode définitif.
    prof = connecter(monde.enseignant_compte)
    assert _saisir(prof, monde, 'cc', 12).status_code == 201
    rep = admin.put(f'/api/annees-scolaires/{monde.annee_id}', json={'mode_evaluation': 'lycee'})
    assert rep.status_code == 400
    annee = admin.get(f'/api/annees-scolaires/{monde.annee_id}').get_json()
    assert annee['mode_evaluation'] == 'college' and annee['mode_verrouille'] is True
    # Le reste de l'année reste modifiable.
    assert admin.put(f'/api/annees-scolaires/{monde.annee_id}',
                     json={'libelle': '2026-2027', 'mode_evaluation': 'college'}).status_code == 200


def test_espace_enseignant_expose_le_mode(monde, connecter):
    _mode(monde, 'institut')
    prof = connecter(monde.enseignant_compte)
    annees = prof.get('/api/enseignant/mon-espace').get_json()['annees_scolaires']
    annee = next(a for a in annees if a['id'] == monde.annee_id)
    assert annee['mode_evaluation'] == 'institut'
    assert [c['code'] for c in annee['composantes']] == ['cc', 'ds', 'evtr']


def test_notes_lycee_existantes_restent_lisibles(monde):
    """Ligne créée sans composante (données d'avant la migration) : 'note'."""
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=Decimal('14')))
    db.session.commit()
    _data, ligne = _bulletin(monde)
    assert ligne['moyenne'] == 14.0
