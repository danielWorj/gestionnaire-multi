"""Document du conseil de classe : périmètres, droits, contenu."""
from extensions import db
from models.evaluation_models import Note
from models.inscription_models import Eleve, Inscription
from models.pedagogie_models import MatiereClasse
from models.structure_models import Classe, Cycle


def _eleve(monde, nom, valeur, classe_id=None, sexe='M'):
    e = Eleve(etablissement_id=monde.etab_id, matricule=f'M-{nom}', nom=nom, prenom='X', sexe=sexe,
              lieu_naissance='Douala', parent_id=monde.parent_id)
    db.session.add(e)
    db.session.flush()
    i = Inscription(eleve_id=e.id, classe_id=classe_id or monde.classe_id, annee_scolaire_id=monde.annee_id,
                    date_inscription=db.session.get(Inscription, monde.inscription_id).date_inscription)
    db.session.add(i)
    db.session.flush()
    mc = MatiereClasse.query.filter_by(classe_id=classe_id or monde.classe_id).first()
    db.session.add(Note(inscription_id=i.id, matiere_classe_id=mc.id, sequence_id=monde.sequence_id, valeur=valeur))
    return i


def _url(monde, portee='classe', cible=None, periode=None, route=''):
    return (f"/api/conseil/{route}?annee_scolaire_id={monde.annee_id}&periode={periode or f'seq:{monde.sequence_id}'}"
            f"&portee={portee}&cible={cible if cible is not None else monde.classe_id}")


def test_conseil_d_une_classe(monde, connecter):
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=17))
    _eleve(monde, 'Bas', 5)
    _eleve(monde, 'Moyen', 12.5, sexe='F')
    db.session.commit()
    admin = connecter(monde.admin_compte)
    data = admin.get(_url(monde)).get_json()
    s = data['classes'][0]
    assert s['effectif'] == 3 and s['nb_sup_10'] == 2
    assert [d['libelle'][:5] for d in s['distinctions'] if d['eleves']] == ['Félic', 'Table']
    assert s['sanctions'][1]['eleves'][0]['nom'].startswith('BAS')
    assert [e['nom'][:3] for e in s['difficulte']] == ['BAS']
    assert s['matieres'][0]['taux'] == 66.7
    html = admin.get(_url(monde, route='html'))
    assert html.status_code == 200 and 'CONSEIL DE CLASSE' in html.get_data(as_text=True)


def test_resultats_par_matiere_du_mieux_au_moins_compris(monde, connecter):
    from models.pedagogie_models import Matiere
    # Mathématiques : 17 et 8 -> 50 % de réussite.
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=17))
    second = _eleve(monde, 'Second', 8)
    # Anglais : tous sous la moyenne ; Français : tous au-dessus.
    for libelle, notes in (('Anglais', (6, 8)), ('Français', (15, 16))):
        m = Matiere(etablissement_id=monde.etab_id, libelle=libelle,
                    groupe_id=db.session.get(Matiere, monde.matiere_id).groupe_id)
        db.session.add(m)
        db.session.flush()
        mc = MatiereClasse(classe_id=monde.classe_id, matiere_id=m.id, enseignant_id=monde.enseignant_id, coefficient=2)
        db.session.add(mc)
        db.session.flush()
        for inscription_id, valeur in zip((monde.inscription_id, second.id), notes):
            db.session.add(Note(inscription_id=inscription_id, matiere_classe_id=mc.id,
                                sequence_id=monde.sequence_id, valeur=valeur))
    db.session.commit()
    s = connecter(monde.admin_compte).get(_url(monde)).get_json()['classes'][0]
    assert [(m['matiere'], m['taux']) for m in s['matieres']] == [
        ('Français', 100.0), ('Mathématiques', 50.0), ('Anglais', 0.0)]


def test_conseil_annuel_propose_les_decisions(monde, connecter):
    db.session.add(Note(inscription_id=monde.inscription_id, matiere_classe_id=monde.mc_id,
                        sequence_id=monde.sequence_id, valeur=9))
    db.session.commit()
    admin = connecter(monde.admin_compte)
    data = admin.get(_url(monde, periode='annuel')).get_json()
    assert data['classes'][0]['classement'][0]['decision'] == 'Redouble (à statuer)'


def test_conseil_etablissement_niveau_cycle(monde, connecter):
    cycle = db.session.get(Classe, monde.classe_id).cycle
    autre = Classe(etablissement_id=monde.etab_id, cycle_id=cycle.id, option='B')
    db.session.add(autre)
    db.session.flush()
    db.session.add(MatiereClasse(classe_id=autre.id, matiere_id=monde.matiere_id, enseignant_id=monde.enseignant_id, coefficient=2))
    db.session.flush()
    _eleve(monde, 'Autre', 14, classe_id=autre.id)
    db.session.commit()
    admin = connecter(monde.admin_compte)
    perim = admin.get('/api/conseil/perimetres').get_json()
    assert len(perim['classes']) == 2 and len(perim['cycles']) == 1
    data = admin.get(_url(monde, portee='etablissement', cible='')).get_json()
    assert data['globale']['nb_classes_scolaires'] == 2
    assert data['comparatif'][0]['taux_reussite'] == 100.0
    data = admin.get(_url(monde, portee='cycle', cible=cycle.id)).get_json()
    assert len(data['classes']) == 2
    niveau = perim['niveaux'][0]['cle']
    assert admin.get(_url(monde, portee='niveau', cible=niveau)).status_code == 200


def test_droits_conseil(monde, connecter):
    censeur = connecter(monde.censeur_compte)
    assert censeur.get(_url(monde)).status_code == 200
    assert censeur.get(_url(monde, portee='etablissement', cible='')).status_code == 403
    prof = connecter(monde.enseignant_compte)
    assert prof.get(_url(monde)).status_code == 403
