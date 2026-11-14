"""Épreuves : dépôt (formats, taille, signature), isolation entre enseignants et
entre établissements, pagination serveur (6 enseignant / 10 admin), filtres,
téléchargement, suppression et audit."""
import io
import os
import zipfile
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from extensions import db
from models.audit_models import JournalAudit
from models.authentification_models import Role
from models.epreuve_models import Epreuve
from models.pedagogie_models import Departement, Enseignant, Grade, Matiere, MatiereClasse
from models.structure_models import Classe, Cycle, Etablissement
from services.authentification_services import create_utilisateur
import services.epreuve_services as epreuve_services

URL_ENSEIGNANT = '/api/enseignant/epreuves'
URL_ADMIN = '/api/epreuves/'

PDF = b'%PDF-1.4\n' + b'0' * 64
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 64
JPG = b'\xff\xd8\xff\xe0' + b'\x00' * 64
WEBP = b'RIFF\x00\x00\x00\x00WEBP' + b'\x00' * 32
DOC = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + b'\x00' * 64
MO = 1024 * 1024


def _zip(noms):
    tampon = io.BytesIO()
    with zipfile.ZipFile(tampon, 'w') as archive:
        for nom in noms:
            archive.writestr(nom, '<x/>')
    return tampon.getvalue()


DOCX = _zip(['[Content_Types].xml', 'word/document.xml'])
XLSX = _zip(['[Content_Types].xml', 'xl/workbook.xml'])  # un ZIP Office, mais pas du Word


@pytest.fixture(autouse=True)
def dossier_epreuves(appli, tmp_path):
    # Jamais dans le vrai storage/ pendant les tests.
    appli.config['EPREUVES_STORAGE_PATH'] = str(tmp_path)
    return tmp_path


# ---------------------------------------------------------------------------
# Outils
# ---------------------------------------------------------------------------

def _deposer(api, url, contenu=PDF, nom='epreuve.pdf', **champs):
    data = {cle: str(valeur) for cle, valeur in champs.items() if valeur is not None}
    if contenu is not None:
        data['fichier'] = (io.BytesIO(contenu), nom)
    return api.client.post(url, data=data, headers=api._entetes(), content_type='multipart/form-data')


def _fichiers(dossier, etab_id):
    d = dossier / str(etab_id)
    return sorted(os.listdir(d)) if d.exists() else []


def _role_id(nom):
    return Role.query.filter_by(libelle=nom).first().id


def _en_base(monde, n, mc_id=None, enseignant_id=None, prefixe='Ep', debut=None):
    """n épreuves insérées directement (sans fichier), de la plus ancienne à la
    plus récente — pour les tests de pagination et de filtres."""
    debut = debut or datetime(2026, 11, 1)
    for i in range(n):
        db.session.add(Epreuve(
            etablissement_id=monde.etab_id, matiere_classe_id=mc_id or monde.mc_id,
            enseignant_id=enseignant_id or monde.enseignant_id, annee_scolaire_id=monde.annee_id,
            titre=f'{prefixe} {i + 1}', nom_original=f'{prefixe}{i + 1}.pdf', fichier=f'{prefixe}{i + 1}.pdf',
            mime='application/pdf', taille=10, created_at=debut + timedelta(minutes=i),
        ))
    db.session.commit()


@pytest.fixture()
def collegue(monde):
    """Second enseignant du même établissement, titulaire d'une autre matière
    dans la même classe : (compte, enseignant_id, matiere_classe_id)."""
    compte, status = create_utilisateur(
        {'nom': 'Collegue Test', 'role_ids': [_role_id('Enseignant')], 'etablissement_id': monde.etab_id})
    assert status == 201, compte
    dep = Departement.query.filter_by(etablissement_id=monde.etab_id).first()
    grade = Grade.query.filter_by(etablissement_id=monde.etab_id).first()
    ens = Enseignant(etablissement_id=monde.etab_id, nom='Collegue', prenom='Test',
                     departement_id=dep.id, grade_id=grade.id, utilisateur_id=compte['id'])
    matiere = Matiere(etablissement_id=monde.etab_id, libelle='Physique',
                      groupe_id=db.session.get(Matiere, monde.matiere_id).groupe_id)
    db.session.add_all([ens, matiere])
    db.session.flush()
    mc = MatiereClasse(classe_id=monde.classe_id, matiere_id=matiere.id, enseignant_id=ens.id, coefficient=2)
    db.session.add(mc)
    db.session.commit()
    return SimpleNamespace(compte=compte, enseignant_id=ens.id, mc_id=mc.id, matiere_id=matiere.id)


@pytest.fixture()
def seconde_classe(monde):
    """Autre classe du même établissement où le MÊME enseignant donne la même
    matière : (classe_id, matiere_classe_id)."""
    cycle = Cycle(etablissement_id=monde.etab_id, libelle='5e')
    db.session.add(cycle)
    db.session.flush()
    classe = Classe(etablissement_id=monde.etab_id, cycle_id=cycle.id, option='B')
    db.session.add(classe)
    db.session.flush()
    mc = MatiereClasse(classe_id=classe.id, matiere_id=monde.matiere_id,
                       enseignant_id=monde.enseignant_id, coefficient=3)
    db.session.add(mc)
    db.session.commit()
    return SimpleNamespace(classe_id=classe.id, mc_id=mc.id)


@pytest.fixture()
def etablissement_b(monde):
    """Un AUTRE établissement : un admin, un enseignant et sa matière-classe."""
    etab = Etablissement(code='TST2', nom='Autre lycée')
    db.session.add(etab)
    db.session.flush()
    cycle = Cycle(etablissement_id=etab.id, libelle='6e')
    db.session.add(cycle)
    db.session.flush()
    classe = Classe(etablissement_id=etab.id, cycle_id=cycle.id)
    dep = Departement(etablissement_id=etab.id, libelle='Maths')
    grade = Grade(etablissement_id=etab.id, libelle='PLEG')
    db.session.add_all([classe, dep, grade])
    db.session.flush()
    from models.structure_models import AnneeScolaire
    from models.pedagogie_models import GroupeMatiere
    annee = AnneeScolaire(etablissement_id=etab.id, libelle='2026-2027', active=True)
    groupe = GroupeMatiere(etablissement_id=etab.id, libelle='Sciences')
    db.session.add_all([annee, groupe])
    db.session.flush()
    matiere = Matiere(etablissement_id=etab.id, libelle='Maths B', groupe_id=groupe.id)
    db.session.add(matiere)
    db.session.flush()

    compte_ens, _ = create_utilisateur({'nom': 'Prof B', 'role_ids': [_role_id('Enseignant')], 'etablissement_id': etab.id})
    compte_admin, _ = create_utilisateur({'nom': 'Admin B', 'role_ids': [_role_id('Admin')], 'etablissement_id': etab.id})
    ens = Enseignant(etablissement_id=etab.id, nom='Prof', prenom='B', departement_id=dep.id, grade_id=grade.id,
                     utilisateur_id=compte_ens['id'])
    db.session.add(ens)
    db.session.flush()
    mc = MatiereClasse(classe_id=classe.id, matiere_id=matiere.id, enseignant_id=ens.id, coefficient=2)
    db.session.add(mc)
    db.session.commit()
    return SimpleNamespace(etab_id=etab.id, classe_id=classe.id, mc_id=mc.id, enseignant_id=ens.id,
                           compte_enseignant=compte_ens, compte_admin=compte_admin, annee_id=annee.id)


# ---------------------------------------------------------------------------
# Dépôt par l'enseignant
# ---------------------------------------------------------------------------

def test_depot_enseignant_valide(monde, connecter, dossier_epreuves):
    prof = connecter(monde.enseignant_compte)
    rep = _deposer(prof, URL_ENSEIGNANT, PDF, 'Devoir séquence 1.pdf',
                   matiere_classe_id=monde.mc_id, titre='  Devoir de maths  ')
    assert rep.status_code == 201, rep.get_json()
    data = rep.get_json()
    assert data['titre'] == 'Devoir de maths'
    assert data['nom_original'] == 'Devoir séquence 1.pdf'
    assert data['mime'] == 'application/pdf'
    assert data['taille'] == len(PDF)
    assert data['matiere_classe_id'] == monde.mc_id
    assert data['classe_id'] == monde.classe_id
    assert data['classe_label'] == '6e'
    assert data['matiere_id'] == monde.matiere_id
    assert data['matiere_libelle'] == 'Mathématiques'
    assert data['enseignant_id'] == monde.enseignant_id
    assert data['enseignant_nom'] == 'Prof Test'
    assert data['annee_scolaire_id'] == monde.annee_id
    # Le nom du fichier sur disque n'est jamais exposé.
    assert 'fichier' not in data

    fichiers = _fichiers(dossier_epreuves, monde.etab_id)
    assert len(fichiers) == 1 and fichiers[0].endswith('.pdf')
    assert fichiers[0] != 'Devoir séquence 1.pdf'
    assert db.session.get(Epreuve, data['id']).etablissement_id == monde.etab_id


@pytest.mark.parametrize('contenu,nom,mime', [
    (PDF, 'a.pdf', 'application/pdf'),
    (PDF, 'A.PDF', 'application/pdf'),
    (DOC, 'a.doc', 'application/msword'),
    (DOCX, 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    (JPG, 'a.jpg', 'image/jpeg'),
    (JPG, 'a.jpeg', 'image/jpeg'),
    (PNG, 'a.png', 'image/png'),
    (WEBP, 'a.webp', 'image/webp'),
])
def test_formats_acceptes(monde, connecter, contenu, nom, mime):
    prof = connecter(monde.enseignant_compte)
    rep = _deposer(prof, URL_ENSEIGNANT, contenu, nom, matiere_classe_id=monde.mc_id, titre='Épreuve')
    assert rep.status_code == 201, rep.get_json()
    assert rep.get_json()['mime'] == mime


@pytest.mark.parametrize('contenu,nom', [
    (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'x.svg'),
    (b'GIF89a' + b'\x00' * 32, 'x.gif'),
    (b'MZ\x90\x00' + b'\x00' * 64, 'virus.exe'),
    (b'MZ\x90\x00' + b'\x00' * 64, 'virus.pdf'),   # extension trompeuse : c'est la signature qui compte
    (b'pas un pdf du tout', 'x.pdf'),
    (XLSX, 'classeur.docx'),                       # ZIP Office, mais pas du Word
    (b'PK\x03\x04pas une archive', 'x.docx'),
    (PNG, 'x.pdf'),                                # extension et contenu discordants
    (PDF, 'x.png'),
    (DOCX, 'x.doc'),
    (PDF, 'sans_extension'),
    (b'', 'vide.pdf'),
])
def test_formats_refuses(monde, connecter, dossier_epreuves, contenu, nom):
    prof = connecter(monde.enseignant_compte)
    rep = _deposer(prof, URL_ENSEIGNANT, contenu, nom, matiere_classe_id=monde.mc_id, titre='Épreuve')
    assert rep.status_code == 400, rep.get_json()
    assert _fichiers(dossier_epreuves, monde.etab_id) == []
    assert Epreuve.query.count() == 0


def test_taille_maximale(monde, connecter, dossier_epreuves):
    prof = connecter(monde.enseignant_compte)
    trop_gros = PDF + b'0' * (15 * MO)
    rep = _deposer(prof, URL_ENSEIGNANT, trop_gros, matiere_classe_id=monde.mc_id, titre='Gros')
    assert rep.status_code == 400
    assert '15 Mo' in rep.get_json()['erreur']
    assert _fichiers(dossier_epreuves, monde.etab_id) == []

    # Pile 15 Mo : accepté.
    limite = PDF + b'0' * (15 * MO - len(PDF))
    assert len(limite) == 15 * MO
    rep = _deposer(prof, URL_ENSEIGNANT, limite, matiere_classe_id=monde.mc_id, titre='Limite')
    assert rep.status_code == 201, rep.get_json()


def test_champs_obligatoires(monde, connecter, dossier_epreuves):
    prof = connecter(monde.enseignant_compte)
    assert _deposer(prof, URL_ENSEIGNANT, matiere_classe_id=monde.mc_id).status_code == 400            # titre
    assert _deposer(prof, URL_ENSEIGNANT, matiere_classe_id=monde.mc_id, titre='   ').status_code == 400
    assert _deposer(prof, URL_ENSEIGNANT, matiere_classe_id=monde.mc_id,
                    titre='x' * 151).status_code == 400
    assert _deposer(prof, URL_ENSEIGNANT, contenu=None, matiere_classe_id=monde.mc_id,
                    titre='Sans fichier').status_code == 400
    assert _deposer(prof, URL_ENSEIGNANT, titre='Sans matière').status_code == 400
    assert _deposer(prof, URL_ENSEIGNANT, matiere_classe_id='abc', titre='Id invalide').status_code == 400
    assert Epreuve.query.count() == 0
    assert _fichiers(dossier_epreuves, monde.etab_id) == []


def test_nom_original_hostile_ne_sert_jamais_de_chemin(monde, connecter, dossier_epreuves):
    prof = connecter(monde.enseignant_compte)
    rep = _deposer(prof, URL_ENSEIGNANT, PDF, '../../etc/passwd.pdf', matiere_classe_id=monde.mc_id, titre='Hostile')
    assert rep.status_code == 201, rep.get_json()
    assert rep.get_json()['nom_original'] == 'passwd.pdf'
    fichiers = _fichiers(dossier_epreuves, monde.etab_id)
    assert len(fichiers) == 1 and '..' not in fichiers[0] and 'passwd' not in fichiers[0]
    # Rien n'a été écrit en dehors du dossier de l'établissement.
    assert sorted(os.listdir(dossier_epreuves)) == [str(monde.etab_id)]


def test_echec_du_commit_supprime_le_fichier(monde, connecter, dossier_epreuves, monkeypatch):
    prof = connecter(monde.enseignant_compte)

    def commit_en_echec():
        raise RuntimeError('base indisponible')

    monkeypatch.setattr(epreuve_services.db.session, 'commit', commit_en_echec)
    rep = _deposer(prof, URL_ENSEIGNANT, PDF, matiere_classe_id=monde.mc_id, titre='Echec')
    assert rep.status_code == 500
    assert _fichiers(dossier_epreuves, monde.etab_id) == []


def test_sans_annee_scolaire(monde, connecter, dossier_epreuves, monkeypatch):
    monkeypatch.setattr(epreuve_services, 'annee_active', lambda etab_id: None)
    prof = connecter(monde.enseignant_compte)
    rep = _deposer(prof, URL_ENSEIGNANT, PDF, matiere_classe_id=monde.mc_id, titre='Sans année')
    assert rep.status_code == 400
    assert _fichiers(dossier_epreuves, monde.etab_id) == []


# ---------------------------------------------------------------------------
# Isolation
# ---------------------------------------------------------------------------

def test_enseignant_ne_depose_que_dans_ses_matieres(monde, connecter, collegue, etablissement_b, dossier_epreuves):
    prof = connecter(monde.enseignant_compte)
    # Matière d'un collègue (même classe, même établissement) : 403.
    rep = _deposer(prof, URL_ENSEIGNANT, PDF, matiere_classe_id=collegue.mc_id, titre='Intrus')
    assert rep.status_code == 403
    # Matière d'un autre établissement : même refus, rien ne fuite.
    rep = _deposer(prof, URL_ENSEIGNANT, PDF, matiere_classe_id=etablissement_b.mc_id, titre='Intrus')
    assert rep.status_code == 403
    # Matière-classe inexistante : même refus.
    assert _deposer(prof, URL_ENSEIGNANT, PDF, matiere_classe_id=99999, titre='Intrus').status_code == 403
    # Le couple classe + matière du collègue est refusé de la même façon.
    rep = _deposer(prof, URL_ENSEIGNANT, PDF, classe_id=monde.classe_id, matiere_id=collegue.matiere_id, titre='Intrus')
    assert rep.status_code == 403
    assert Epreuve.query.count() == 0
    assert _fichiers(dossier_epreuves, monde.etab_id) == []


def test_isolation_entre_enseignants(monde, connecter, collegue):
    prof = connecter(monde.enseignant_compte)
    autre = connecter(collegue.compte)
    id_prof = _deposer(prof, URL_ENSEIGNANT, PDF, matiere_classe_id=monde.mc_id, titre='Du prof').get_json()['id']
    id_autre = _deposer(autre, URL_ENSEIGNANT, PDF, matiere_classe_id=collegue.mc_id, titre='Du collègue').get_json()['id']

    assert [e['id'] for e in prof.get(URL_ENSEIGNANT).get_json()['items']] == [id_prof]
    assert [e['id'] for e in autre.get(URL_ENSEIGNANT).get_json()['items']] == [id_autre]

    # Un enseignant_id passé en paramètre n'ouvre rien.
    items = prof.get(f'{URL_ENSEIGNANT}?enseignant_id={collegue.enseignant_id}').get_json()['items']
    assert [e['id'] for e in items] == [id_prof]

    # Suppression de l'épreuve d'un collègue : introuvable, et toujours là.
    assert prof.delete(f'{URL_ENSEIGNANT}/{id_autre}').status_code == 404
    assert db.session.get(Epreuve, id_autre) is not None


def test_isolation_entre_etablissements(monde, connecter, etablissement_b, dossier_epreuves):
    prof_a = connecter(monde.enseignant_compte)
    prof_b = connecter(etablissement_b.compte_enseignant)
    admin_a = connecter(monde.admin_compte)
    admin_b = connecter(etablissement_b.compte_admin)

    id_a = _deposer(prof_a, URL_ENSEIGNANT, PDF, matiere_classe_id=monde.mc_id, titre='Lycée A').get_json()['id']
    id_b = _deposer(prof_b, URL_ENSEIGNANT, PDF, matiere_classe_id=etablissement_b.mc_id, titre='Lycée B').get_json()['id']
    assert _fichiers(dossier_epreuves, monde.etab_id) != _fichiers(dossier_epreuves, etablissement_b.etab_id)

    assert [e['id'] for e in admin_a.get(URL_ADMIN).get_json()['items']] == [id_a]
    assert [e['id'] for e in admin_b.get(URL_ADMIN).get_json()['items']] == [id_b]

    # Téléchargement et suppression d'une épreuve d'un autre établissement : 404.
    assert admin_b.get(f'/api/epreuves/{id_a}/fichier').status_code == 404
    assert admin_b.delete(f'/api/epreuves/{id_a}').status_code == 404
    assert db.session.get(Epreuve, id_a) is not None

    # L'admin ne peut pas déposer dans une matière-classe d'un autre établissement.
    rep = _deposer(admin_a, URL_ADMIN, PDF, matiere_classe_id=etablissement_b.mc_id, titre='Intrus')
    assert rep.status_code == 404
    # Ni choisir un autre établissement par paramètre : seul le SuperAdmin le peut.
    items = admin_a.get(f'{URL_ADMIN}?etablissement_id={etablissement_b.etab_id}').get_json()['items']
    assert [e['id'] for e in items] == [id_a]


def test_acces_par_role(monde, connecter, appli):
    prof = connecter(monde.enseignant_compte)
    admin = connecter(monde.admin_compte)
    censeur = connecter(monde.censeur_compte)

    # Espace admin : ni l'enseignant ni le censeur.
    for api in (prof, censeur):
        assert api.get(URL_ADMIN).status_code == 403
        assert _deposer(api, URL_ADMIN, PDF, matiere_classe_id=monde.mc_id, titre='x').status_code == 403
        assert api.get('/api/epreuves/1/fichier').status_code == 403
        assert api.delete('/api/epreuves/1').status_code == 403
    # Espace enseignant : réservé au rôle Enseignant.
    for api in (admin, censeur):
        assert api.get(URL_ENSEIGNANT).status_code == 403
        assert _deposer(api, URL_ENSEIGNANT, PDF, matiere_classe_id=monde.mc_id, titre='x').status_code == 403
    # Sans session.
    anonyme = appli.test_client()
    assert anonyme.get(URL_ADMIN).status_code == 401
    assert anonyme.get(URL_ENSEIGNANT).status_code == 401
    assert anonyme.get('/api/epreuves/1/fichier').status_code == 401


def test_enseignant_sans_profil_relie(monde, connecter):
    compte, status = create_utilisateur(
        {'nom': 'Sans Profil', 'role_ids': [_role_id('Enseignant')], 'etablissement_id': monde.etab_id})
    assert status == 201
    api = connecter(compte)
    assert api.get(URL_ENSEIGNANT).status_code == 404
    assert _deposer(api, URL_ENSEIGNANT, PDF, matiere_classe_id=monde.mc_id, titre='x').status_code == 404


def test_superadmin_choisit_l_etablissement(monde, connecter, connecter_superadmin, etablissement_b):
    prof = connecter(monde.enseignant_compte)
    id_a = _deposer(prof, URL_ENSEIGNANT, PDF, matiere_classe_id=monde.mc_id, titre='Lycée A').get_json()['id']
    sa = connecter_superadmin()

    assert sa.get(URL_ADMIN).status_code == 400  # etablissement_id requis
    items = sa.get(f'{URL_ADMIN}?etablissement_id={monde.etab_id}').get_json()['items']
    assert [e['id'] for e in items] == [id_a]
    assert sa.get(f'{URL_ADMIN}?etablissement_id={etablissement_b.etab_id}').get_json()['total'] == 0

    rep = _deposer(sa, f'{URL_ADMIN}?etablissement_id={etablissement_b.etab_id}', PDF,
                   matiere_classe_id=etablissement_b.mc_id, titre='Posé par le SuperAdmin')
    assert rep.status_code == 201, rep.get_json()
    assert rep.get_json()['etablissement_id'] == etablissement_b.etab_id
    # La matière-classe du lycée A n'est pas atteignable depuis le lycée B.
    rep = _deposer(sa, f'{URL_ADMIN}?etablissement_id={etablissement_b.etab_id}', PDF,
                   matiere_classe_id=monde.mc_id, titre='Mauvais établissement')
    assert rep.status_code == 404


# ---------------------------------------------------------------------------
# Dépôt par l'administration
# ---------------------------------------------------------------------------

def test_depot_admin_deduit_l_enseignant(monde, connecter, collegue):
    admin = connecter(monde.admin_compte)

    # Par matiere_classe_id.
    rep = _deposer(admin, URL_ADMIN, PDF, matiere_classe_id=collegue.mc_id, titre='Pour le collègue')
    assert rep.status_code == 201, rep.get_json()
    data = rep.get_json()
    assert data['enseignant_id'] == collegue.enseignant_id
    assert data['enseignant_nom'] == 'Collegue Test'
    assert data['matiere_libelle'] == 'Physique'

    # Par classe + matière : même résultat, enseignant déduit de MatiereClasse.
    rep = _deposer(admin, URL_ADMIN, PDF, classe_id=monde.classe_id, matiere_id=monde.matiere_id, titre='Maths')
    assert rep.status_code == 201, rep.get_json()
    assert rep.get_json()['enseignant_id'] == monde.enseignant_id
    assert rep.get_json()['matiere_classe_id'] == monde.mc_id

    # Le collègue la voit dans SA liste ; le premier enseignant ne voit pas celle du collègue.
    ids_collegue = [e['titre'] for e in connecter(collegue.compte).get(URL_ENSEIGNANT).get_json()['items']]
    assert ids_collegue == ['Pour le collègue']


def test_depot_admin_erreurs(monde, connecter):
    admin = connecter(monde.admin_compte)
    assert _deposer(admin, URL_ADMIN, PDF, matiere_classe_id=99999, titre='x').status_code == 404
    assert _deposer(admin, URL_ADMIN, PDF, classe_id=monde.classe_id, matiere_id=99999, titre='x').status_code == 404
    assert _deposer(admin, URL_ADMIN, PDF, classe_id=monde.classe_id, titre='x').status_code == 400
    assert _deposer(admin, URL_ADMIN, PDF, titre='x').status_code == 400
    assert Epreuve.query.count() == 0


# ---------------------------------------------------------------------------
# Pagination et filtres
# ---------------------------------------------------------------------------

def test_pagination_enseignant_par_6(monde, connecter):
    _en_base(monde, 14)
    prof = connecter(monde.enseignant_compte)

    p1 = prof.get(URL_ENSEIGNANT).get_json()
    assert (p1['total'], p1['page'], p1['pages'], p1['per_page']) == (14, 1, 3, 6)
    assert [e['titre'] for e in p1['items']] == [f'Ep {i}' for i in range(14, 8, -1)]  # plus récentes d'abord

    p2 = prof.get(f'{URL_ENSEIGNANT}?page=2').get_json()
    assert p2['page'] == 2 and len(p2['items']) == 6
    p3 = prof.get(f'{URL_ENSEIGNANT}?page=3').get_json()
    assert [e['titre'] for e in p3['items']] == ['Ep 2', 'Ep 1']

    # Aucune épreuve en double ni oubliée d'une page à l'autre.
    ids = [e['id'] for p in (p1, p2, p3) for e in p['items']]
    assert len(ids) == len(set(ids)) == 14

    # Page trop grande : la dernière ; paramètre invalide : la première.
    assert prof.get(f'{URL_ENSEIGNANT}?page=99').get_json()['page'] == 3
    assert prof.get(f'{URL_ENSEIGNANT}?page=0').get_json()['page'] == 1
    assert prof.get(f'{URL_ENSEIGNANT}?page=abc').get_json()['page'] == 1


def test_pagination_admin_par_10(monde, connecter):
    _en_base(monde, 14)
    admin = connecter(monde.admin_compte)

    p1 = admin.get(URL_ADMIN).get_json()
    assert (p1['total'], p1['page'], p1['pages'], p1['per_page']) == (14, 1, 2, 10)
    assert len(p1['items']) == 10
    p2 = admin.get(f'{URL_ADMIN}?page=2').get_json()
    assert [e['titre'] for e in p2['items']] == ['Ep 4', 'Ep 3', 'Ep 2', 'Ep 1']

    # per_page explicite, borné à 50.
    assert len(admin.get(f'{URL_ADMIN}?per_page=3').get_json()['items']) == 3
    assert admin.get(f'{URL_ADMIN}?per_page=1000').get_json()['per_page'] == 50


def test_liste_vide(monde, connecter):
    for api, url in ((connecter(monde.enseignant_compte), URL_ENSEIGNANT), (connecter(monde.admin_compte), URL_ADMIN)):
        data = api.get(url).get_json()
        assert (data['items'], data['total'], data['page'], data['pages']) == ([], 0, 1, 1)


def test_filtres(monde, connecter, collegue, seconde_classe):
    _en_base(monde, 3, mc_id=monde.mc_id, prefixe='Maths6')                            # prof, maths, 6e
    _en_base(monde, 2, mc_id=seconde_classe.mc_id, prefixe='Maths5')                   # prof, maths, 5e B
    _en_base(monde, 4, mc_id=collegue.mc_id, enseignant_id=collegue.enseignant_id, prefixe='Phys6')  # collègue, physique, 6e

    admin = connecter(monde.admin_compte)
    prof = connecter(monde.enseignant_compte)

    def total(api, url, **params):
        qs = '&'.join(f'{k}={v}' for k, v in params.items())
        return api.get(f'{url}?{qs}').get_json()['total']

    # Admin : tous les filtres, seuls ou combinés.
    assert total(admin, URL_ADMIN) == 9
    assert total(admin, URL_ADMIN, classe_id=monde.classe_id) == 7
    assert total(admin, URL_ADMIN, classe_id=seconde_classe.classe_id) == 2
    assert total(admin, URL_ADMIN, matiere_id=monde.matiere_id) == 5
    assert total(admin, URL_ADMIN, matiere_id=collegue.matiere_id) == 4
    assert total(admin, URL_ADMIN, enseignant_id=monde.enseignant_id) == 5
    assert total(admin, URL_ADMIN, enseignant_id=collegue.enseignant_id) == 4
    assert total(admin, URL_ADMIN, classe_id=monde.classe_id, matiere_id=monde.matiere_id) == 3
    assert total(admin, URL_ADMIN, classe_id=monde.classe_id, enseignant_id=collegue.enseignant_id) == 4
    assert total(admin, URL_ADMIN, classe_id=seconde_classe.classe_id, matiere_id=collegue.matiere_id) == 0
    assert total(admin, URL_ADMIN, annee_scolaire_id=monde.annee_id) == 9
    assert total(admin, URL_ADMIN, annee_scolaire_id=99999) == 0

    # Le filtre porte aussi sur la pagination : total et pages suivent.
    data = admin.get(f'{URL_ADMIN}?classe_id={monde.classe_id}&per_page=3').get_json()
    assert (data['total'], data['pages'], len(data['items'])) == (7, 3, 3)

    # Enseignant : filtres classe et matière, sur SES épreuves seulement.
    assert total(prof, URL_ENSEIGNANT) == 5
    assert total(prof, URL_ENSEIGNANT, classe_id=monde.classe_id) == 3
    assert total(prof, URL_ENSEIGNANT, classe_id=seconde_classe.classe_id) == 2
    assert total(prof, URL_ENSEIGNANT, matiere_id=monde.matiere_id) == 5
    assert total(prof, URL_ENSEIGNANT, matiere_id=collegue.matiere_id) == 0   # matière d'un collègue : rien


def test_liste_enrichie(monde, connecter, seconde_classe):
    _en_base(monde, 1, mc_id=seconde_classe.mc_id)
    item = connecter(monde.admin_compte).get(URL_ADMIN).get_json()['items'][0]
    assert item['classe_label'] == '5e B'
    assert item['matiere_libelle'] == 'Mathématiques'
    assert item['enseignant_nom'] == 'Prof Test'
    assert 'fichier' not in item


# ---------------------------------------------------------------------------
# Téléchargement et suppression
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('contenu,nom,mime', [
    (PDF, 'Épreuve séquence 1.pdf', 'application/pdf'),
    (DOCX, 'sujet.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    (JPG, 'scan.jpg', 'image/jpeg'),
])
def test_telechargement(monde, connecter, contenu, nom, mime):
    prof = connecter(monde.enseignant_compte)
    epreuve_id = _deposer(prof, URL_ENSEIGNANT, contenu, nom, matiere_classe_id=monde.mc_id, titre='À télécharger').get_json()['id']

    rep = connecter(monde.admin_compte).get(f'/api/epreuves/{epreuve_id}/fichier')
    assert rep.status_code == 200
    assert rep.data == contenu
    assert rep.mimetype == mime
    disposition = rep.headers['Content-Disposition']
    assert disposition.startswith('attachment')
    if nom.isascii():
        assert f'filename={nom}' in disposition
    else:
        assert "filename*=UTF-8''" in disposition   # nom accentué encodé (RFC 5987)
    assert rep.headers['X-Content-Type-Options'] == 'nosniff'
    assert rep.headers['Cache-Control'] == 'private, no-store'


def test_telechargement_introuvable(monde, connecter, dossier_epreuves):
    admin = connecter(monde.admin_compte)
    assert admin.get('/api/epreuves/99999/fichier').status_code == 404

    # Ligne en base mais fichier disparu du disque : 404 explicite, pas de 500.
    _en_base(monde, 1)
    epreuve = Epreuve.query.first()
    rep = admin.get(f'/api/epreuves/{epreuve.id}/fichier')
    assert rep.status_code == 404
    assert 'introuvable' in rep.get_json()['erreur'].lower()


def test_suppression_par_l_enseignant(monde, connecter, dossier_epreuves):
    prof = connecter(monde.enseignant_compte)
    epreuve_id = _deposer(prof, URL_ENSEIGNANT, PDF, matiere_classe_id=monde.mc_id, titre='À supprimer').get_json()['id']
    assert len(_fichiers(dossier_epreuves, monde.etab_id)) == 1

    assert prof.delete(f'{URL_ENSEIGNANT}/{epreuve_id}').status_code == 200
    assert db.session.get(Epreuve, epreuve_id) is None
    assert _fichiers(dossier_epreuves, monde.etab_id) == []
    assert prof.delete(f'{URL_ENSEIGNANT}/{epreuve_id}').status_code == 404


def test_suppression_par_l_admin(monde, connecter, dossier_epreuves):
    prof = connecter(monde.enseignant_compte)
    admin = connecter(monde.admin_compte)
    epreuve_id = _deposer(prof, URL_ENSEIGNANT, PDF, matiere_classe_id=monde.mc_id, titre='À supprimer').get_json()['id']

    assert admin.delete(f'/api/epreuves/{epreuve_id}').status_code == 200
    assert db.session.get(Epreuve, epreuve_id) is None
    assert _fichiers(dossier_epreuves, monde.etab_id) == []
    assert admin.delete(f'/api/epreuves/{epreuve_id}').status_code == 404


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

def test_audit_automatique(monde, connecter):
    prof = connecter(monde.enseignant_compte)
    epreuve_id = _deposer(prof, URL_ENSEIGNANT, PDF, matiere_classe_id=monde.mc_id, titre='Tracée').get_json()['id']
    prof.delete(f'{URL_ENSEIGNANT}/{epreuve_id}')

    lignes = (JournalAudit.query.filter_by(table_nom='epreuve', ligne_id=str(epreuve_id))
              .order_by(JournalAudit.id).all())
    assert [ligne.action for ligne in lignes] == ['creation', 'suppression']
    creation = lignes[0]
    assert creation.etablissement_id == monde.etab_id
    assert creation.auteur_role == 'Enseignant'
    assert creation.changements['titre'] == [None, 'Tracée']
