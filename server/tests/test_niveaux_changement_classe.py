"""Niveaux et changement de classe : au sein du même niveau, notes et
paiements suivent l'élève ; changement de niveau refusé s'il a des données."""
from datetime import date
from decimal import Decimal

from extensions import db
from models.evaluation_models import Note
from models.inscription_models import Inscription
from models.paiements_models import LignePaiement, Paiement, TrancheClasse
from models.pedagogie_models import MatiereClasse
from models.structure_models import Classe, Cycle, Etablissement, Niveau
from services.bulletin_services import construire_bulletins


def _classe(monde, option, cycle_libelle='6e'):
    cycle = Cycle.query.filter_by(etablissement_id=monde.etab_id, libelle=cycle_libelle).first()
    if cycle is None:
        cycle = Cycle(etablissement_id=monde.etab_id, libelle=cycle_libelle)
        db.session.add(cycle)
        db.session.flush()
    classe = Classe(etablissement_id=monde.etab_id, cycle_id=cycle.id, option=option)
    db.session.add(classe)
    db.session.flush()
    return classe


def _meme_matiere(monde, classe):
    mc = MatiereClasse(classe_id=classe.id, matiere_id=monde.matiere_id, enseignant_id=monde.enseignant_id, coefficient=4)
    db.session.add(mc)
    db.session.flush()
    return mc


def _paiement(monde, classe_id, ordre=1):
    tranche = TrancheClasse(classe_id=classe_id, annee_scolaire_id=monde.annee_id, libelle=f'Tranche {ordre}',
                            ordre=ordre, montant_attendu=Decimal('10000'))
    db.session.add(tranche)
    db.session.flush()
    p = Paiement(inscription_id=monde.inscription_id, parent_id=monde.parent_id, encaisse_par_id=monde.admin_compte['id'],
                 numero_recu=f'R{classe_id}{ordre}', montant_total=Decimal('5000'), mode_paiement='ESPECES', statut='VALIDE')
    db.session.add(p)
    db.session.flush()
    db.session.add(LignePaiement(paiement_id=p.id, tranche_classe_id=tranche.id, montant_verse=Decimal('5000')))
    db.session.flush()
    return tranche


def _preparer(monde):
    """Classe du monde = « 6e A » ; note 15 et un versement."""
    db.session.get(Classe, monde.classe_id).option = 'A'
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=15))
    _paiement(monde, monde.classe_id)
    db.session.commit()


def test_meme_niveau_les_notes_et_paiements_suivent(monde, connecter):
    _preparer(monde)
    b = _classe(monde, 'B')
    mc_b = _meme_matiere(monde, b)
    tranche_b = TrancheClasse(classe_id=b.id, annee_scolaire_id=monde.annee_id, libelle='T1', ordre=1,
                              montant_attendu=Decimal('12000'))
    db.session.add(tranche_b)
    db.session.commit()
    admin = connecter(monde.admin_compte)
    rep = admin.put(f'/api/inscriptions/{monde.inscription_id}', json={'classe_id': b.id})
    assert rep.status_code == 200, rep.get_json()
    assert Note.query.one().matiere_classe_id == mc_b.id
    assert LignePaiement.query.one().tranche_classe_id == tranche_b.id
    bulletin = construire_bulletins(db.session.get(Etablissement, monde.etab_id), b.id, monde.annee_id,
                                    f'seq:{monde.sequence_id}')
    assert bulletin['bulletins'][0]['moyenne'] == 15.0


def test_matiere_absente_de_la_nouvelle_classe_refuse(monde, connecter):
    _preparer(monde)
    b = _classe(monde, 'B')
    db.session.add(TrancheClasse(classe_id=b.id, annee_scolaire_id=monde.annee_id, libelle='T1', ordre=1,
                                 montant_attendu=Decimal('12000')))
    db.session.commit()
    admin = connecter(monde.admin_compte)
    rep = admin.put(f'/api/inscriptions/{monde.inscription_id}', json={'classe_id': b.id})
    assert rep.status_code == 409 and rep.get_json()['code'] == 'transfert_incomplet'
    assert rep.get_json()['matieres'] == ['Mathématiques']
    assert db.session.get(Inscription, monde.inscription_id).classe_id == monde.classe_id


def test_changement_de_niveau_refuse_avec_des_notes(monde, connecter):
    _preparer(monde)
    cinquieme = _classe(monde, 'A', cycle_libelle='5e')
    _meme_matiere(monde, cinquieme)
    db.session.commit()
    admin = connecter(monde.admin_compte)
    rep = admin.put(f'/api/inscriptions/{monde.inscription_id}', json={'classe_id': cinquieme.id})
    assert rep.status_code == 409 and rep.get_json()['code'] == 'changement_niveau'


def test_niveau_explicite_prime_sur_le_nom(monde, connecter):
    _preparer(monde)
    autre = _classe(monde, 'Bilingue', cycle_libelle='Sixième')   # nom différent, même niveau voulu
    _meme_matiere(monde, autre)
    db.session.add(TrancheClasse(classe_id=autre.id, annee_scolaire_id=monde.annee_id, libelle='T1', ordre=1,
                                 montant_attendu=Decimal('12000')))
    niveau = Niveau(etablissement_id=monde.etab_id, libelle='6E')
    db.session.add(niveau)
    db.session.flush()
    db.session.get(Classe, monde.classe_id).niveau_id = niveau.id
    autre.niveau_id = niveau.id
    db.session.commit()
    admin = connecter(monde.admin_compte)
    assert admin.put(f'/api/inscriptions/{monde.inscription_id}', json={'classe_id': autre.id}).status_code == 200


def test_generer_niveaux_depuis_les_noms(monde, connecter):
    db.session.get(Classe, monde.classe_id).option = 'A'
    _classe(monde, 'B')
    _classe(monde, 'A', cycle_libelle='5e')
    db.session.commit()
    admin = connecter(monde.admin_compte)
    rep = admin.post('/api/niveaux/generer')
    assert rep.status_code == 200 and rep.get_json() == {'crees': 2, 'classes_rangees': 3}
    libelles = sorted(n['libelle'] for n in admin.get('/api/niveaux/').get_json())
    assert len(libelles) == 2


def test_sans_donnees_changement_de_niveau_libre(monde, connecter):
    cinquieme = _classe(monde, 'A', cycle_libelle='5e')
    db.session.commit()
    admin = connecter(monde.admin_compte)
    assert admin.put(f'/api/inscriptions/{monde.inscription_id}', json={'classe_id': cinquieme.id}).status_code == 200
