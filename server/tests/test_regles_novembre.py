"""Règles du 17/11/2026 : troncature des moyennes du bulletin, ordre
chronologique des séquences, verrouillage de la saisie des notes, droits de
l'Admin / du titulaire / du comptable, solvabilité sans année active."""
from datetime import date, datetime, timedelta

from extensions import db
from models.authentification_models import Role
from models.evaluation_models import Note
from models.pedagogie_models import Enseignant, Matiere, MatiereClasse, TitulaireClasse
from models.structure_models import AnneeScolaire, Etablissement, Sequence, Trimestre, sequences_de_annee
from services.authentification_services import create_utilisateur
from services.bulletin_services import construire_bulletins


def _compte(monde, nom, role):
    r = Role.query.filter_by(libelle=role).first()
    res, status = create_utilisateur({'nom': nom, 'role_ids': [r.id], 'etablissement_id': monde.etab_id})
    assert status == 201, res
    return res


def _note(api, monde, valeur, sequence_id=None):
    return api.post('/api/notes/', json={'inscription_id': monde.inscription_id, 'matiere_classe_id': monde.mc_id,
                                          'sequence_id': sequence_id or monde.sequence_id, 'valeur': valeur})


def _titulaire(monde):
    db.session.add(TitulaireClasse(classe_id=monde.classe_id, enseignant_id=monde.enseignant_id,
                                   annee_scolaire_id=monde.annee_id))
    db.session.commit()


# --- Bulletin : 2 décimales tronquées ------------------------------------

def test_bulletin_tronque_et_seuils_sur_la_valeur_affichee(monde):
    mc = db.session.get(MatiereClasse, monde.mc_id)
    mc.coefficient = 1
    groupe = db.session.get(Matiere, monde.matiere_id).groupe_id
    for libelle in ('A', 'B'):
        mat = Matiere(etablissement_id=monde.etab_id, libelle=libelle, groupe_id=groupe)
        db.session.add(mat)
        db.session.flush()
        autre = MatiereClasse(classe_id=monde.classe_id, matiere_id=mat.id, enseignant_id=monde.enseignant_id, coefficient=1)
        db.session.add(autre)
        db.session.flush()
        db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=autre.id,
                            sequence_id=monde.sequence_id, valeur=10))
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=9.99))
    db.session.commit()
    b = construire_bulletins(db.session.get(Etablissement, monde.etab_id), monde.classe_id, monde.annee_id,
                             f'seq:{monde.sequence_id}')['bulletins'][0]
    assert b['moyenne'] == 9.99            # 29,99 / 3 = 9,9966… -> 9,99 (jamais 10,00)
    assert b['mention'] == 'Médiocre'


# --- Séquences dans l'ordre des dates -----------------------------------

def test_sequences_triees_par_date_et_non_par_creation(monde):
    seq1 = db.session.get(Sequence, monde.sequence_id)
    seq1.date_debut = date(2026, 11, 1)
    # Créée APRÈS, mais commence AVANT.
    seq0 = Sequence(trimestre_id=monde.trimestre_id, libelle='Seq0', date_debut=date(2026, 9, 15))
    db.session.add(seq0)
    db.session.commit()
    assert [s.libelle for s in sequences_de_annee(monde.annee_id)] == ['Seq0', 'Seq1']


# --- Verrouillage des séquences ------------------------------------------

def test_sequence_verrouillee_apres_sa_date_de_fin(monde, connecter):
    seq = db.session.get(Sequence, monde.sequence_id)
    seq.date_fin = date.today() - timedelta(days=1)
    db.session.commit()
    prof = connecter(monde.enseignant_compte)
    rep = _note(prof, monde, 12)
    assert rep.status_code == 403 and rep.get_json()['code'] == 'sequence_verrouillee'
    # L'administration corrige toujours.
    admin = connecter(monde.admin_compte)
    assert _note(admin, monde, 12).status_code == 201
    # Rouverte par l'administration : l'enseignant saisit de nouveau.
    assert admin.put(f'/api/sequences/{monde.sequence_id}', json={'etat_saisie': 'ouverte'}).status_code == 200
    assert _note(prof, monde, 13).status_code == 200


def test_cloture_manuelle_et_saisie_hors_connexion_anterieure(monde, connecter):
    admin = connecter(monde.admin_compte)
    prof = connecter(monde.enseignant_compte)
    assert _note(prof, monde, 11).status_code == 201
    rep = admin.put(f'/api/sequences/{monde.sequence_id}', json={'etat_saisie': 'cloturee'})
    assert rep.status_code == 200 and rep.get_json()['verrouillee'] is True
    assert db.session.get(Sequence, monde.sequence_id).cloturee_le is not None
    note_id = Note.query.first().id
    assert prof.put(f'/api/notes/{note_id}', json={'valeur': 15}).status_code == 403
    assert prof.delete(f'/api/notes/{note_id}').status_code == 403
    # Saisie faite sur l'appareil AVANT la clôture, envoyée après : acceptée.
    avant = (datetime.utcnow() - timedelta(hours=1)).isoformat() + 'Z'
    rep = prof.put(f'/api/notes/{note_id}', json={'valeur': 14}, headers={'X-Saisi-Hors-Ligne-Le': avant})
    assert rep.status_code == 200, rep.get_json()


def test_etat_saisie_invalide_refuse(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert admin.put(f'/api/sequences/{monde.sequence_id}', json={'etat_saisie': 'nimporte'}).status_code == 400
    censeur = connecter(monde.censeur_compte)
    assert censeur.put(f'/api/sequences/{monde.sequence_id}', json={'etat_saisie': 'cloturee'}).status_code == 403


# --- Droits ---------------------------------------------------------------

def test_admin_saisit_les_notes(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert _note(admin, monde, 16).status_code == 201
    assert admin.get('/api/notes/').status_code == 200
    assert admin.post('/api/disciplines/', json={'inscription_id': monde.inscription_id,
                                                 'sequence_id': monde.sequence_id, 'retards': 1}).status_code == 201


def test_titulaire_bulletins_pv_discipline_emploi_du_temps(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    bulletin = f'/api/bulletins/?classe_id={monde.classe_id}&annee_scolaire_id={monde.annee_id}&periode=seq:{monde.sequence_id}'
    pv = f'/api/pv/?classe_id={monde.classe_id}&annee_scolaire_id={monde.annee_id}&sequence_id={monde.sequence_id}'
    discipline = {'inscription_id': monde.inscription_id, 'sequence_id': monde.sequence_id, 'retards': 2}
    horaire = f'/api/enseignant/horaire?annee_scolaire_id={monde.annee_id}&classe_id={monde.classe_id}'
    # Pas titulaire : rien.
    assert prof.get(bulletin).status_code == 403
    assert prof.get(pv).status_code == 403
    assert prof.post('/api/disciplines/', json=discipline).status_code == 403
    assert prof.get(horaire).status_code == 403
    assert prof.get('/api/auth/me').get_json()['est_titulaire'] is False
    _titulaire(monde)
    assert prof.get('/api/auth/me').get_json()['est_titulaire'] is True
    assert prof.get(bulletin).status_code == 200
    assert prof.get(pv).status_code == 200
    assert prof.post('/api/disciplines/', json=discipline).status_code == 201
    assert prof.get(horaire).status_code == 200
    assert prof.get('/api/horaires/').status_code == 200
    # Consultation seulement de l'emploi du temps.
    assert prof.post('/api/horaires/', json={}).status_code == 403


def test_titulaire_voit_toutes_les_notes_de_sa_classe_sans_les_modifier(monde, connecter):
    groupe = db.session.get(Matiere, monde.matiere_id).groupe_id
    mat = Matiere(etablissement_id=monde.etab_id, libelle='Anglais', groupe_id=groupe)
    db.session.add(mat)
    db.session.flush()
    moi = db.session.get(Enseignant, monde.enseignant_id)
    collegue = Enseignant(etablissement_id=monde.etab_id, nom='Collègue', prenom='Prof',
                          departement_id=moi.departement_id, grade_id=moi.grade_id)
    db.session.add(collegue)
    db.session.flush()
    autre_mc = MatiereClasse(classe_id=monde.classe_id, matiere_id=mat.id, enseignant_id=collegue.id, coefficient=2)
    db.session.add(autre_mc)
    db.session.flush()
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=autre_mc.id,
                        sequence_id=monde.sequence_id, valeur=8))
    db.session.commit()
    prof = connecter(monde.enseignant_compte)
    assert prof.get('/api/notes/').get_json() == []
    _titulaire(monde)
    notes = prof.get('/api/notes/').get_json()
    assert [n['matiere_classe_id'] for n in notes] == [autre_mc.id]
    assert prof.put(f"/api/notes/{notes[0]['id']}", json={'valeur': 9}).status_code == 404


def test_censeur_genere_le_pv_de_ses_classes(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    url = f'/api/pv/?classe_id={monde.classe_id}&annee_scolaire_id={monde.annee_id}&sequence_id={monde.sequence_id}'
    assert censeur.get(url).status_code == 200


def test_comptable_lit_le_journal_financier_seulement(monde, connecter):
    comptable = connecter(_compte(monde, 'Compta', 'Comptable'))
    admin = connecter(monde.admin_compte)
    _note(admin, monde, 12)   # entrée « note » dans le journal
    rep = comptable.get('/api/audit/')
    assert rep.status_code == 200
    assert all(e['table'] in ('tranche_classe', 'paiement', 'ligne_paiement', 'categorie_tresorerie',
                                  'compte_tresorerie', 'mouvement_tresorerie', 'ventilation_depense')
               for e in rep.get_json()['items'])
    assert comptable.get('/api/audit/?table=note').get_json()['total'] == 0


def test_solvabilite_sans_annee_active_prend_la_plus_recente(monde, connecter):
    db.session.get(AnneeScolaire, monde.annee_id).active = False
    db.session.commit()
    admin = connecter(monde.admin_compte)
    rep = admin.get('/api/paiements/solvabilite')
    assert rep.status_code == 200, rep.get_json()
