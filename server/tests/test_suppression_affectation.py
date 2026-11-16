"""Suppression d'une affectation matière-classe : vierge -> supprimée ;
liée -> 409 + historique ; ?cascade=1 (administrateur) -> tout supprimé et
journalisé."""

from datetime import time

import pytest

from extensions import db
from models.audit_models import JournalAudit
from models.emploi_du_temps_models import CreneauHoraire, Horaire
from models.evaluation_models import Note
from models.pedagogie_models import Matiere, MatiereClasse


@pytest.fixture()
def admin(monde, connecter):
    return connecter(monde.admin_compte)


def _donnees_liees(monde):
    note = Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                sequence_id=monde.sequence_id, valeur=14.5)
    creneau = CreneauHoraire(etablissement_id=monde.etab_id, libelle='H1', heure_debut=time(7, 30),
                             heure_fin=time(8, 25))
    db.session.add_all([note, creneau])
    db.session.flush()
    db.session.add(Horaire(matiere_classe_id=monde.mc_id, annee_scolaire_id=monde.annee_id,
                           jour_semaine='Lundi', creneau_id=creneau.id, salle='B12'))
    db.session.commit()


def test_affectation_vierge_supprimee_directement(monde, admin):
    matiere = Matiere(etablissement_id=monde.etab_id, libelle='Anglais',
                      groupe_id=db.session.get(Matiere, monde.matiere_id).groupe_id)
    db.session.add(matiere)
    db.session.flush()
    mc = MatiereClasse(classe_id=monde.classe_id, matiere_id=matiere.id, enseignant_id=monde.enseignant_id,
                       coefficient=2)
    db.session.add(mc)
    db.session.commit()
    rep = admin.delete(f'/api/matieres-classe/{mc.id}')
    assert rep.status_code == 200, rep.get_json()
    assert db.session.get(MatiereClasse, mc.id) is None


def test_affectation_liee_refusee_puis_historique(monde, admin):
    _donnees_liees(monde)
    rep = admin.delete(f'/api/matieres-classe/{monde.mc_id}')
    assert rep.status_code == 409
    corps = rep.get_json()
    assert corps['code'] == 'affectation_liee' and corps['details'] == {'notes': 1, 'horaires': 1}
    assert db.session.get(MatiereClasse, monde.mc_id) is not None

    hist = admin.get(f'/api/matieres-classe/{monde.mc_id}/historique').get_json()
    assert hist['affectation']['matiere'] == 'Mathématiques'
    assert hist['affectation']['coefficient'] == 4
    assert [(n['eleve'], n['valeur'], n['sequence']) for n in hist['notes']] == [('Eleve Un', 14.5, 'Seq1')]
    assert hist['horaires'][0]['jour'] == 'Lundi' and hist['horaires'][0]['debut'] == '07:30'
    assert hist['epreuves'] == []


def test_cascade_refusee_au_censeur(monde, connecter):
    _donnees_liees(monde)
    rep = connecter(monde.censeur_compte).delete(f'/api/matieres-classe/{monde.mc_id}?cascade=1')
    assert rep.status_code == 403
    assert db.session.get(MatiereClasse, monde.mc_id) is not None


def test_cascade_supprime_tout_et_journalise(monde, admin):
    _donnees_liees(monde)
    rep = admin.delete(f'/api/matieres-classe/{monde.mc_id}?cascade=1')
    assert rep.status_code == 200, rep.get_json()
    assert rep.get_json()['supprime'] == {'notes': 1, 'horaires': 1, 'epreuves': 0}
    db.session.expire_all()
    assert db.session.get(MatiereClasse, monde.mc_id) is None
    assert Note.query.filter_by(matiere_classe_id=monde.mc_id).count() == 0
    assert Horaire.query.filter_by(matiere_classe_id=monde.mc_id).count() == 0

    journal = JournalAudit.query.filter_by(table_nom='matiere_classe', ligne_id=str(monde.mc_id),
                                           action='suppression').all()
    recap = [j for j in journal if (j.changements or {}).get('evenement')]
    assert len(recap) == 1
    c = recap[0].changements
    assert c['notes'] == [1, 0] and c['horaires'] == [1, 0]
    assert c['affectation'][0].startswith('Mathématiques')
    assert recap[0].auteur_nom == 'Admin Test' and recap[0].etablissement_id == monde.etab_id
    # Chaque note supprimée a aussi sa propre trace.
    assert JournalAudit.query.filter_by(table_nom='note', action='suppression').count() == 1

    # Le journal est consultable par l'administrateur.
    rep = admin.get(f'/api/audit/?table=matiere_classe&ligne_id={monde.mc_id}')
    assert rep.status_code == 200
