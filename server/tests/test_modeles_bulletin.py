"""Modèles de bulletin : choix par établissement parmi ceux de son mode
d'évaluation, rendu de chaque gabarit, données supplémentaires (extrêmes,
moyenne de classe, moyennes de groupe)."""
import pytest

from extensions import db
from models.evaluation_models import Note
from models.structure_models import AnneeScolaire, Etablissement, MODELES_BULLETIN
from services.bulletin_services import construire_bulletins
from services.structure_services import create_etablissement, update_etablissement


def _url_html(monde):
    return (f'/api/bulletins/html?classe_id={monde.classe_id}&annee_scolaire_id={monde.annee_id}'
            f'&periode=seq:{monde.sequence_id}')


def _choisir(monde, code):
    db.session.get(Etablissement, monde.etab_id).modele_bulletin = code
    db.session.commit()


def _noter(monde, valeur):
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=valeur))
    db.session.commit()


def test_creation_modele_par_defaut_et_validation(appli):
    res, status = create_etablissement({'nom': 'A', 'region': 'Centre'})
    assert status == 201 and res['modele_bulletin'] == 'original'

    # Chaque mode reçoit son modèle « Original ».
    res, status = create_etablissement({'nom': 'A2', 'region': 'Centre', 'mode_evaluation': 'institut'})
    assert status == 201 and res['modele_bulletin'] == 'original_institut'

    res, status = create_etablissement({'nom': 'B', 'region': 'Centre', 'modele_bulletin': 'bilingue_groupes'})
    assert status == 201 and res['modele_bulletin'] == 'bilingue_groupes'

    # Modèle hors du mode d'évaluation ou inconnu : refusé.
    _, status = create_etablissement({'nom': 'C', 'region': 'Centre', 'mode_evaluation': 'college',
                                      'modele_bulletin': 'bilingue_groupes'})
    assert status == 400
    _, status = create_etablissement({'nom': 'D', 'region': 'Centre', 'modele_bulletin': 'inconnu'})
    assert status == 400


def test_modification_du_modele(monde):
    etab = db.session.get(Etablissement, monde.etab_id)
    res, status = update_etablissement(etab, {'modele_bulletin': 'professeurs_groupes'})
    assert status == 200 and res['modele_bulletin'] == 'professeurs_groupes'

    # Passage en Collège sans préciser de modèle : modèle par défaut du Collège.
    res, status = update_etablissement(etab, {'mode_evaluation': 'college'})
    assert status == 200 and res['modele_bulletin'] == 'original_college'
    _, status = update_etablissement(etab, {'modele_bulletin': 'original_extremes'})
    assert status == 400


def test_donnees_supplementaires(monde):
    _noter(monde, 13.5)
    data = construire_bulletins(db.session.get(Etablissement, monde.etab_id), monde.classe_id, monde.annee_id,
                                f'seq:{monde.sequence_id}')
    b = data['bulletins'][0]
    groupe = b['groupes'][0]
    ligne = groupe['lignes'][0]
    assert (ligne['note_min'], ligne['note_max'], ligne['moyenne_classe']) == (13.5, 13.5, 13.5)
    assert ligne['appreciation_longue'] == 'Acquis'
    assert groupe['moyennes_colonnes'] == [13.5]
    assert b['travail']['tableau_honneur'] is True and b['travail']['blame'] is False
    assert data['modele_bulletin']['code'] == 'original'


@pytest.mark.parametrize('code', [c for c, m in MODELES_BULLETIN.items() if 'lycee' in m['modes']])
def test_rendu_de_chaque_modele(monde, connecter, code):
    _noter(monde, 13.5)
    _choisir(monde, code)
    rep = connecter(monde.admin_compte).get(_url_html(monde))
    assert rep.status_code == 200
    html = rep.get_data(as_text=True)
    assert 'Mathématiques' in html and 'Eleve Un' in html
    if code == 'original_extremes':
        assert 'Extrêmes' in html
    if code == 'original':
        assert 'Extrêmes' not in html
    if code == 'bilingue_groupes':
        assert 'TOTAL SCIENCES' in html and 'PROFIL DE LA CLASSE' in html
    if code == 'professeurs_groupes':
        assert 'Prof Test' in html and 'MOY DU PREMIER' in html


def _mode_annee(monde, mode):
    db.session.get(AnneeScolaire, monde.annee_id).mode_evaluation = mode
    db.session.commit()


def _evaluer(monde, **valeurs):
    for composante, valeur in valeurs.items():
        db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                            sequence_id=monde.sequence_id, composante=composante, valeur=valeur))
    db.session.commit()


def test_annee_d_un_autre_mode_utilise_le_modele_par_defaut(monde, connecter):
    _choisir(monde, 'bilingue_groupes')
    _mode_annee(monde, 'college')
    html = connecter(monde.admin_compte).get(_url_html(monde)).get_data(as_text=True)
    assert 'PROFIL DE LA CLASSE' not in html and 'DÉCISION DU CONSEIL DE CLASSE' in html


def test_original_institut(monde, connecter):
    _choisir(monde, 'original_institut')
    _mode_annee(monde, 'institut')
    _evaluer(monde, cc=11, ds=9, evtr=8)
    html = connecter(monde.admin_compte).get(_url_html(monde)).get_data(as_text=True)
    assert 'Ev. Tr. N°1' in html and 'Note N°1' not in html
    assert 'Noms et signatures des enseignants' in html and 'Prof Test' in html
    assert 'RAPPELS MOYENNES' in html and '09.33' in html


def test_evolution_chronologique_des_moyennes(monde, connecter):
    """Rappel des moyennes : moyenne générale de chaque séquence de l'année,
    de la première jusqu'à la fin de la période, en graphe (SVG)."""
    from models.structure_models import Sequence, Trimestre
    _choisir(monde, 'original_institut')
    _mode_annee(monde, 'institut')
    t2 = Trimestre(annee_scolaire_id=monde.annee_id, libelle='T2')
    db.session.add(t2)
    db.session.flush()
    seq2, seq3 = Sequence(trimestre_id=t2.id, libelle='Seq2'), Sequence(trimestre_id=t2.id, libelle='Seq3')
    db.session.add_all([seq2, seq3])
    db.session.commit()
    _evaluer(monde, cc=11, ds=9, evtr=8)  # Seq1 : 9,33
    for composante, valeur in (('cc', 14), ('ds', 12), ('evtr', 13)):  # Seq2 : 13,00
        db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                            sequence_id=seq2.id, composante=composante, valeur=valeur))
    db.session.commit()

    etab = db.session.get(Etablissement, monde.etab_id)
    # Bulletin de la Seq2 : Seq1 (antérieure) puis Seq2 ; la Seq3, postérieure, est exclue.
    b = construire_bulletins(etab, monde.classe_id, monde.annee_id, f'seq:{seq2.id}')['bulletins'][0]
    assert [(p['libelle'], p['moyenne'], p['moyenne_classe']) for p in b['evolution']] == [
        ('SEQ1', 9.33, 9.33), ('SEQ2', 13.0, 13.0)]
    # Trimestre 2 (Seq2 + Seq3, sans note) : la Seq3 apparaît, sans point.
    b = construire_bulletins(etab, monde.classe_id, monde.annee_id, f'tri:{t2.id}')['bulletins'][0]
    assert [(p['libelle'], p['moyenne']) for p in b['evolution']] == [('SEQ1', 9.33), ('SEQ2', 13.0), ('SEQ3', None)]

    html = connecter(monde.admin_compte).get(
        f'/api/bulletins/html?classe_id={monde.classe_id}&annee_scolaire_id={monde.annee_id}&periode=tri:{t2.id}'
    ).get_data(as_text=True)
    assert 'RAPPELS MOYENNES' in html and '<svg class="evolution"' in html
    assert '09.33' in html and '13.00' in html and 'SEQ3' in html


def test_original_college_colonne_note(monde, connecter):
    _choisir(monde, 'original_college')
    _mode_annee(monde, 'college')
    _evaluer(monde, cc=11, ds=9)
    data = construire_bulletins(db.session.get(Etablissement, monde.etab_id), monde.classe_id, monde.annee_id,
                                f'seq:{monde.sequence_id}')
    b = data['bulletins'][0]
    assert [c['libelle'] for c in data['colonnes_notes']] == ['CC N°1', 'DS N°1', 'Note N°1']
    assert b['groupes'][0]['lignes'][0]['cellules'] == [11.0, 9.0, pytest.approx(9.6)]
    assert b['groupes'][0]['rang'] == 1 and b['eleve']['numero'] == 1
    assert b['moyennes_colonnes'] == [11.0, 9.0, pytest.approx(9.6)]
    html = connecter(monde.admin_compte).get(_url_html(monde)).get_data(as_text=True)
    assert 'Note N°1' in html and 'Ev. Tr.' not in html
