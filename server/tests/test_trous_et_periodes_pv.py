"""Notes manquantes avant bulletin / PV (liste, saisie, dispense) et
périodes du procès-verbal (trimestre, évaluation seule)."""
from extensions import db
from models.evaluation_models import Note
from models.pedagogie_models import Matiere, MatiereClasse, TitulaireClasse
from models.structure_models import AnneeScolaire, Etablissement, Sequence
from services.bulletin_services import construire_bulletins
from services.pv_services import construire_pv


def _deux_matieres(monde):
    groupe = db.session.get(Matiere, monde.matiere_id).groupe_id
    mat = Matiere(etablissement_id=monde.etab_id, libelle='Anglais', groupe_id=groupe)
    db.session.add(mat)
    db.session.flush()
    mc2 = MatiereClasse(classe_id=monde.classe_id, matiere_id=mat.id, enseignant_id=monde.enseignant_id, coefficient=2)
    db.session.add(mc2)
    db.session.commit()
    return mc2.id


def _note(monde, mc_id, valeur, sequence_id=None, composante='note', absent=False):
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=mc_id, composante=composante,
                        sequence_id=sequence_id or monde.sequence_id, valeur=valeur, absent=absent))
    db.session.commit()


def _etab(monde):
    return db.session.get(Etablissement, monde.etab_id)


def test_liste_des_trous_puis_dispense(monde, connecter):
    mc2 = _deux_matieres(monde)
    _note(monde, monde.mc_id, 14)
    admin = connecter(monde.admin_compte)
    url = f'/api/trous/?classe_id={monde.classe_id}&annee_scolaire_id={monde.annee_id}&periode=seq:{monde.sequence_id}'
    data = admin.get(url).get_json()
    assert data['nb_trous'] == 1
    assert data['eleves'][0]['trous'][0]['matiere_classe_id'] == mc2
    # Avant : élève non classé au PV.
    pv = construire_pv(_etab(monde), monde.classe_id, monde.annee_id, monde.sequence_id)
    assert pv['eleves'][0]['classe'] is False
    cible = {'inscription_id': monde.inscription_id, 'matiere_classe_id': mc2, 'sequence_id': monde.sequence_id}
    assert admin.post('/api/trous/dispense', json=cible).status_code == 201
    assert admin.get(url).get_json()['nb_trous'] == 0
    # Coefficient annulé : moyenne = 14 sur le seul coefficient de Maths.
    pv = construire_pv(_etab(monde), monde.classe_id, monde.annee_id, monde.sequence_id)
    assert pv['eleves'][0]['classe'] is True and pv['eleves'][0]['moyenne'] == 14.0
    assert pv['eleves'][0]['total_coef'] == 4
    b = construire_bulletins(_etab(monde), monde.classe_id, monde.annee_id, f'seq:{monde.sequence_id}')['bulletins'][0]
    assert b['moyenne'] == 14.0 and b['total_coef'] == 4
    ligne = next(l for g in b['groupes'] for l in g['lignes'] if l['matiere'] == 'Anglais')
    assert ligne['dispense'] is True and ligne['cellules'] == ['DISP']
    # Retrait : le trou revient.
    assert admin.post('/api/trous/dispense/retirer', json=cible).status_code == 200
    assert admin.get(url).get_json()['nb_trous'] == 1


def test_combler_un_trou_par_le_titulaire_meme_sequence_close(monde, connecter):
    mc2 = _deux_matieres(monde)
    db.session.add(TitulaireClasse(classe_id=monde.classe_id, enseignant_id=monde.enseignant_id,
                                   annee_scolaire_id=monde.annee_id))
    db.session.get(Sequence, monde.sequence_id).etat_saisie = 'cloturee'
    db.session.commit()
    prof = connecter(monde.enseignant_compte)
    corps = {'inscription_id': monde.inscription_id, 'matiere_classe_id': mc2, 'sequence_id': monde.sequence_id, 'valeur': 11}
    assert prof.post('/api/trous/note', json=corps).status_code == 201
    # Plus un trou : une seconde saisie est refusée (correction = saisie normale).
    assert prof.post('/api/trous/note', json={**corps, 'valeur': 12}).status_code == 409


def test_trous_hors_perimetre(monde, connecter):
    prof = connecter(monde.enseignant_compte)  # pas titulaire
    url = f'/api/trous/?classe_id={monde.classe_id}&annee_scolaire_id={monde.annee_id}&periode=seq:{monde.sequence_id}'
    assert prof.get(url).status_code == 403
    censeur = connecter(monde.censeur_compte)  # classe assignée
    assert censeur.get(url).status_code == 200


def test_pv_trimestre_moyenne_des_sequences(monde):
    seq2 = Sequence(trimestre_id=monde.trimestre_id, libelle='Seq2')
    db.session.add(seq2)
    db.session.commit()
    _note(monde, monde.mc_id, 10)
    _note(monde, monde.mc_id, 15, sequence_id=seq2.id)
    pv = construire_pv(_etab(monde), monde.classe_id, monde.annee_id, periode=f'tri:{monde.trimestre_id}')
    assert pv['eleves'][0]['moyenne'] == 12.5
    assert pv['periode']['type'] == 'trimestre'


def test_pv_par_evaluation_en_college(monde):
    db.session.get(AnneeScolaire, monde.annee_id).mode_evaluation = 'college'
    db.session.commit()
    _note(monde, monde.mc_id, 8, composante='cc')
    _note(monde, monde.mc_id, 16, composante='ds')
    etab = _etab(monde)
    assert construire_pv(etab, monde.classe_id, monde.annee_id, periode=f'seq:{monde.sequence_id}:cc')['eleves'][0]['moyenne'] == 8.0
    assert construire_pv(etab, monde.classe_id, monde.annee_id, periode=f'seq:{monde.sequence_id}:ds')['eleves'][0]['moyenne'] == 16.0
    # « Tout à la fois » : la note de la séquence, 30 % CC + 70 % DS.
    assert construire_pv(etab, monde.classe_id, monde.annee_id, periode=f'seq:{monde.sequence_id}')['eleves'][0]['moyenne'] == 13.6


def test_api_periodes_pv(monde, connecter):
    db.session.get(AnneeScolaire, monde.annee_id).mode_evaluation = 'institut'
    db.session.commit()
    admin = connecter(monde.admin_compte)
    valeurs = [p['value'] for p in admin.get(f'/api/pv/periodes?annee_scolaire_id={monde.annee_id}').get_json()]
    s = monde.sequence_id
    assert valeurs == [f'tri:{monde.trimestre_id}', f'seq:{s}', f'seq:{s}:cc', f'seq:{s}:ds', f'seq:{s}:evtr']
