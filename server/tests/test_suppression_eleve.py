"""Suppression d'un élève / d'une inscription : message clair (409) quand ils
sont déjà liés à des notes, des fiches de discipline ou des paiements, suppression
complète (200) sinon. Régression : l'ancien comportement était un 500 muet."""
from datetime import date

from extensions import db
from models.evaluation_models import Note, Discipline
from models.inscription_models import Eleve, Inscription
from models.paiements_models import Paiement


def _ajouter_note(monde, valeur=12):
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=valeur))
    db.session.commit()


def _ajouter_discipline(monde):
    db.session.add(Discipline(inscription_id=monde.inscription_id, sequence_id=monde.sequence_id))
    db.session.commit()


def test_eleve_inscrit_sans_historique_est_supprime(monde, connecter):
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/eleves/{monde.eleve_id}')
    assert rep.status_code == 200, rep.get_json()
    assert db.session.get(Eleve, monde.eleve_id) is None
    assert Inscription.query.filter_by(eleve_id=monde.eleve_id).count() == 0


def test_eleve_sans_inscription_est_supprime(monde, connecter):
    admin = connecter(monde.admin_compte)
    db.session.delete(db.session.get(Inscription, monde.inscription_id))
    db.session.commit()
    assert admin.delete(f'/api/eleves/{monde.eleve_id}').status_code == 200


def test_eleve_avec_notes_refuse_avec_message_clair(monde, connecter):
    _ajouter_note(monde)
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/eleves/{monde.eleve_id}')
    data = rep.get_json()
    assert rep.status_code == 409, data
    assert data['code'] == 'eleve_lie'
    assert 'Un Eleve' in data['erreur'] and '1 note' in data['erreur'] and 'Inactif' in data['erreur']
    assert data['details'] == {'inscriptions': 1, 'notes': 1}
    # Rien n'a été supprimé.
    assert db.session.get(Eleve, monde.eleve_id) is not None
    assert Inscription.query.filter_by(eleve_id=monde.eleve_id).count() == 1
    assert Note.query.count() == 1


def test_eleve_avec_notes_et_discipline_les_liste_toutes(monde, connecter):
    _ajouter_note(monde, 10)
    _ajouter_discipline(monde)
    admin = connecter(monde.admin_compte)
    data = admin.delete(f'/api/eleves/{monde.eleve_id}').get_json()
    assert '1 note et 1 fiche de discipline' in data['erreur']


def test_eleve_avec_paiement_refuse(monde, connecter):
    db.session.add(Paiement(inscription_id=monde.inscription_id, parent_id=monde.parent_id,
                            encaisse_par_id=monde.admin_compte['id'], numero_recu='R-0001',
                            montant_total=5000, mode_paiement='ESPECES'))
    db.session.commit()
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/eleves/{monde.eleve_id}')
    assert rep.status_code == 409
    assert '1 paiement' in rep.get_json()['erreur']
    assert db.session.get(Eleve, monde.eleve_id) is not None


def test_inscription_avec_notes_refusee(monde, connecter):
    _ajouter_note(monde)
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/inscriptions/{monde.inscription_id}')
    data = rep.get_json()
    assert rep.status_code == 409, data
    assert data['code'] == 'inscription_liee'
    assert '1 note' in data['erreur'] and 'Radié' in data['erreur']
    assert db.session.get(Inscription, monde.inscription_id) is not None


def test_inscription_sans_historique_est_retiree_et_l_eleve_reste(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert admin.delete(f'/api/inscriptions/{monde.inscription_id}').status_code == 200
    assert db.session.get(Eleve, monde.eleve_id) is not None


def test_contrainte_de_cle_etrangere_donne_409_et_non_500(monde, connecter):
    """Filet de sécurité générique (delete_entity) : un élément encore utilisé
    ailleurs (ici un parent qui a des enfants) renvoie 409, jamais 500."""
    admin = connecter(monde.admin_compte)
    rep = admin.delete(f'/api/parents/{monde.parent_id}')
    assert rep.status_code == 409, rep.get_json()
    assert 'encore utilisé' in rep.get_json()['erreur']


# ---------------------------------------------------------------------------
# Suppression définitive en cascade (après le 409) + journal d'historique
# ---------------------------------------------------------------------------

def _ajouter_paiement_avec_ligne(monde):
    from models.paiements_models import LignePaiement, TrancheClasse
    p = Paiement(inscription_id=monde.inscription_id, parent_id=monde.parent_id,
                 encaisse_par_id=monde.admin_compte['id'], numero_recu='R-0042',
                 montant_total=5000, mode_paiement='ESPECES')
    db.session.add(p)
    db.session.flush()
    insc = db.session.get(Inscription, monde.inscription_id)
    tranche = TrancheClasse(classe_id=insc.classe_id, annee_scolaire_id=insc.annee_scolaire_id,
                            libelle='Tranche 1', ordre=1, montant_attendu=5000)
    db.session.add(tranche)
    db.session.flush()
    db.session.add(LignePaiement(paiement_id=p.id, tranche_classe_id=tranche.id, montant_verse=5000))
    return p


def test_historique_liste_notes_discipline_et_paiements(monde, connecter):
    _ajouter_note(monde, 14)
    _ajouter_discipline(monde)
    _ajouter_paiement_avec_ligne(monde)
    db.session.commit()
    admin = connecter(monde.admin_compte)
    rep = admin.get(f'/api/eleves/{monde.eleve_id}/historique')
    data = rep.get_json()
    assert rep.status_code == 200, data
    assert data['inscriptions'] == 1
    assert data['notes'][0]['matiere'] == 'Mathématiques' and data['notes'][0]['valeur'] == 14
    assert len(data['disciplines']) == 1
    assert data['paiements'][0]['numero_recu'] == 'R-0042' and data['total_paye'] == 5000
    assert data['paiements'][0]['tranches'] == [{'libelle': 'Tranche 1', 'montant': 5000}]


def test_suppression_cascade_supprime_tout(monde, connecter):
    _ajouter_note(monde)
    _ajouter_discipline(monde)
    _ajouter_paiement_avec_ligne(monde)
    db.session.commit()
    admin = connecter(monde.admin_compte)
    # Sans cascade : toujours refusé.
    assert admin.delete(f'/api/eleves/{monde.eleve_id}').status_code == 409
    rep = admin.delete(f'/api/eleves/{monde.eleve_id}?cascade=1')
    assert rep.status_code == 200, rep.get_json()
    assert rep.get_json()['supprime'] == {'notes': 1, 'disciplines': 1, 'paiements': 1, 'inscriptions': 1}
    assert db.session.get(Eleve, monde.eleve_id) is None
    assert Inscription.query.filter_by(eleve_id=monde.eleve_id).count() == 0
    from models.paiements_models import LignePaiement
    assert Note.query.count() == 0 and Discipline.query.count() == 0 and Paiement.query.count() == 0
    assert LignePaiement.query.count() == 0


def test_suppression_cascade_refusee_aux_non_admin(monde, connecter):
    from models.authentification_models import Role
    from services.authentification_services import create_utilisateur
    _ajouter_note(monde)
    role = Role.query.filter_by(libelle='Secretaire').first()
    compte, status = create_utilisateur({'nom': 'Secr Test', 'role_ids': [role.id],
                                         'etablissement_id': monde.etab_id})
    assert status == 201, compte
    secr = connecter(compte)
    assert secr.get(f'/api/eleves/{monde.eleve_id}/historique').status_code == 200
    rep = secr.delete(f'/api/eleves/{monde.eleve_id}?cascade=1')
    assert rep.status_code == 403
    assert db.session.get(Eleve, monde.eleve_id) is not None and Note.query.count() == 1
