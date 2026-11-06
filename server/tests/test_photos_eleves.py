"""Photo d'identité des élèves : upload (formats, taille, remplacement),
cloisonnement par établissement et par rôle, affichage sur le bulletin."""
import io
import os

import pytest

from extensions import db
from models.inscription_models import Eleve
from models.structure_models import Classe, Etablissement
import services.inscription_services as inscription_services

PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 64
JPG = b'\xff\xd8\xff\xe0' + b'\x00' * 64


@pytest.fixture(autouse=True)
def dossier_photos(tmp_path, monkeypatch):
    # Jamais dans le vrai storage/ pendant les tests.
    monkeypatch.setattr(inscription_services, 'PHOTOS_ELEVES_DIR', str(tmp_path))
    return tmp_path


def _envoyer(api, eleve_id, contenu, nom='photo.png'):
    return api.client.post(f'/api/eleves/{eleve_id}/photo', data={'photo': (io.BytesIO(contenu), nom)},
                           headers=api._entetes(), content_type='multipart/form-data')


def _fichiers(dossier, monde):
    d = dossier / str(monde.etab_id)
    return sorted(os.listdir(d)) if d.exists() else []


def test_upload_remplacement_et_lecture(monde, connecter, dossier_photos):
    admin = connecter(monde.admin_compte)
    rep = _envoyer(admin, monde.eleve_id, PNG)
    assert rep.status_code == 200, rep.get_json()
    premiere = rep.get_json()['photo_url']
    assert premiere.startswith(f'/api/eleves/{monde.eleve_id}/photo?v=')
    assert len(_fichiers(dossier_photos, monde)) == 1

    rep = _envoyer(admin, monde.eleve_id, JPG, 'photo.jpg')
    url = rep.get_json()['photo_url']
    assert url != premiere
    assert len(_fichiers(dossier_photos, monde)) == 1  # l'ancienne a été supprimée

    rep = admin.get(url)
    assert rep.status_code == 200
    assert rep.mimetype == 'image/jpeg'
    assert rep.data == JPG
    assert rep.headers['Cache-Control'].startswith('private')
    # La liste des élèves expose aussi l'URL.
    eleves = admin.get('/api/eleves/').get_json()
    assert next(e for e in eleves if e['id'] == monde.eleve_id)['photo_url'] == url


@pytest.mark.parametrize('contenu,nom', [
    (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'x.svg'),
    (b'GIF89a' + b'\x00' * 32, 'x.gif'),
    (b'pas une image', 'x.png'),  # extension trompeuse : c'est la signature qui compte
])
def test_formats_refuses(monde, connecter, dossier_photos, contenu, nom):
    admin = connecter(monde.admin_compte)
    rep = _envoyer(admin, monde.eleve_id, contenu, nom)
    assert rep.status_code == 400
    assert _fichiers(dossier_photos, monde) == []


def test_photo_trop_volumineuse(monde, connecter, dossier_photos):
    admin = connecter(monde.admin_compte)
    rep = _envoyer(admin, monde.eleve_id, JPG + b'0' * (2 * 1024 * 1024))
    assert rep.status_code == 400
    assert '2 Mo' in rep.get_json()['erreur']


def test_photo_jamais_modifiable_par_le_json(monde, connecter):
    admin = connecter(monde.admin_compte)
    eleve = admin.get(f'/api/eleves/{monde.eleve_id}').get_json()
    rep = admin.put(f'/api/eleves/{monde.eleve_id}', json={'photo': '../../config.py', 'nom': 'Eleve',
                                                          'version': eleve['version']})
    assert rep.status_code == 200
    assert db.session.get(Eleve, monde.eleve_id).photo is None


def test_cloisonnement(monde, connecter, appli):
    admin = connecter(monde.admin_compte)
    url = _envoyer(admin, monde.eleve_id, PNG).get_json()['photo_url']

    assert appli.test_client().get(url).status_code == 401  # sans session

    # Enseignant / Censeur : pas d'accès au répertoire des élèves.
    assert connecter(monde.enseignant_compte).get(url).status_code == 403
    censeur = connecter(monde.censeur_compte)
    assert censeur.get(url).status_code == 403
    assert _envoyer(censeur, monde.eleve_id, PNG).status_code == 403

    # Admin d'un autre établissement : élève introuvable.
    from models.authentification_models import Role
    from services.authentification_services import create_utilisateur
    autre = Etablissement(code='TST2', nom='Autre lycée')
    db.session.add(autre)
    db.session.commit()
    role_admin = Role.query.filter_by(libelle='Admin').first()
    compte, _ = create_utilisateur({'nom': 'Admin Autre', 'role_ids': [role_admin.id], 'etablissement_id': autre.id})
    assert connecter(compte).get(url).status_code == 404


def test_retrait_et_suppression_de_l_eleve(monde, connecter, dossier_photos):
    admin = connecter(monde.admin_compte)
    _envoyer(admin, monde.eleve_id, PNG)
    rep = admin.delete(f'/api/eleves/{monde.eleve_id}/photo')
    assert rep.status_code == 200
    assert rep.get_json()['photo_url'] is None
    assert _fichiers(dossier_photos, monde) == []

    # Suppression de l'élève : sa photo part avec lui.
    eleve = Eleve(etablissement_id=monde.etab_id, matricule='M900', nom='Sans', prenom='Classe', sexe='M',
                  lieu_naissance='Douala', parent_id=monde.parent_id)
    db.session.add(eleve)
    db.session.commit()
    _envoyer(admin, eleve.id, PNG)
    assert len(_fichiers(dossier_photos, monde)) == 1
    assert admin.delete(f'/api/eleves/{eleve.id}').status_code == 200
    assert _fichiers(dossier_photos, monde) == []


def _url_bulletin_html(monde):
    return (f'/api/bulletins/html?classe_id={monde.classe_id}&annee_scolaire_id={monde.annee_id}'
            f'&periode=seq:{monde.sequence_id}')


def test_photo_sur_le_bulletin(monde, connecter):
    admin = connecter(monde.admin_compte)
    sans_photo = admin.get(_url_bulletin_html(monde))
    assert sans_photo.status_code == 200
    assert 'class="photo"' not in sans_photo.get_data(as_text=True)

    _envoyer(admin, monde.eleve_id, PNG)
    html = admin.get(_url_bulletin_html(monde)).get_data(as_text=True)
    assert f'/api/bulletins/photos/{monde.eleve_id}?v=' in html

    # Le Censeur de la classe voit la photo de son élève via le bulletin.
    censeur = connecter(monde.censeur_compte)
    html = censeur.get(_url_bulletin_html(monde)).get_data(as_text=True)
    src = html.split(f'/api/bulletins/photos/{monde.eleve_id}', 1)[1].split('"', 1)[0]
    rep = censeur.get(f'/api/bulletins/photos/{monde.eleve_id}{src}')
    assert rep.status_code == 200
    assert rep.data == PNG


def test_photo_bulletin_hors_perimetre_du_censeur(monde, connecter):
    admin = connecter(monde.admin_compte)
    _envoyer(admin, monde.eleve_id, PNG)
    # L'élève passe dans une classe qui n'est pas assignée au Censeur.
    from models.inscription_models import Inscription
    autre = Classe(etablissement_id=monde.etab_id, cycle_id=db.session.get(Classe, monde.classe_id).cycle_id, option='Z')
    db.session.add(autre)
    db.session.flush()
    db.session.get(Inscription, monde.inscription_id).classe_id = autre.id
    db.session.commit()

    censeur = connecter(monde.censeur_compte)
    assert censeur.get(f'/api/bulletins/photos/{monde.eleve_id}').status_code == 404
    assert admin.get(f'/api/bulletins/photos/{monde.eleve_id}').status_code == 200
