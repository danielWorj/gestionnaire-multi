import io
import math
import os
import uuid
import zipfile

from flask import current_app

from extensions import db
from models.epreuve_models import Epreuve
from models.pedagogie_models import Enseignant, Matiere, MatiereClasse
from models.structure_models import Classe, Cycle, annee_active


# ---------------------------------------------------------------------------
# Épreuves : documents (PDF, Word, images) déposés par les enseignants, ou par
# l'administration pour leur compte.
#
# Stockage : <EPREUVES_STORAGE_PATH>/<etablissement_id>/<uuid>.<ext> (même
# volume Docker persistant que les logos et les photos, cf.
# docker-compose.prod.yml : server-storage), sous un nom ALÉATOIRE jamais
# dérivé du nom envoyé. Le nom d'origine est conservé en base, uniquement
# pour nommer le téléchargement.
#
# Formats : PDF, DOC, DOCX, JPEG, PNG, WEBP. Pas de SVG (peut embarquer du
# script), ni de formats Office à macros. Chaque fichier est vérifié sur son
# EXTENSION et sur sa SIGNATURE binaire, et les deux doivent concorder : une
# extension trompeuse (un exécutable renommé « .pdf ») est refusée. Le type
# MIME enregistré est celui déduit de la signature, jamais celui annoncé par
# le navigateur.
#
# Même séquence que les photos d'élèves (cf. inscription_services) : fichier
# écrit sur disque, puis commit ; si le commit échoue, le fichier est retiré.
# À la suppression, le fichier n'est retiré qu'APRÈS le commit réussi : une
# épreuve ne pointe jamais vers un fichier disparu.
# ---------------------------------------------------------------------------

EPREUVE_TAILLE_MAX = 15 * 1024 * 1024  # 15 Mo
TITRE_MAX = 150
NOM_FICHIER_MAX = 255
PER_PAGE_MAX = 50

# Extensions acceptées -> format canonique.
FORMAT_PAR_EXTENSION = {
    'pdf': 'pdf',
    'doc': 'doc',
    'docx': 'docx',
    'jpg': 'jpg',
    'jpeg': 'jpg',
    'png': 'png',
    'webp': 'webp',
}

MIME_PAR_FORMAT = {
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'jpg': 'image/jpeg',
    'png': 'image/png',
    'webp': 'image/webp',
}

MESSAGE_FORMATS = "Format non pris en charge (PDF, DOC, DOCX, JPEG, PNG ou WEBP uniquement)"

_SIGNATURE_OLE = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'  # ancien format Word (.doc)


# ---------------------------------------------------------------------------
# Validation du fichier
# ---------------------------------------------------------------------------

def _est_docx(contenu):
    """Un .docx est une archive ZIP (signature « PK ») contenant le document
    Word : on vérifie la présence de word/document.xml pour ne pas accepter
    n'importe quelle archive, ni un classeur Excel ou une présentation
    PowerPoint (également des ZIP). Seule la table des entrées est lue, rien
    n'est décompressé."""
    if not contenu.startswith(b'PK\x03\x04'):
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(contenu)) as archive:
            noms = set(archive.namelist())
    except (zipfile.BadZipFile, ValueError):
        return False
    return 'word/document.xml' in noms and '[Content_Types].xml' in noms


def format_detecte(contenu):
    """Format canonique d'après la signature binaire, ou None."""
    if contenu.startswith(b'%PDF-'):
        return 'pdf'
    if contenu.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if contenu.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if contenu[:4] == b'RIFF' and contenu[8:12] == b'WEBP':
        return 'webp'
    if contenu.startswith(_SIGNATURE_OLE):
        return 'doc'
    if _est_docx(contenu):
        return 'docx'
    return None


def _nom_affichage(filename):
    """Nom d'origine nettoyé : sans chemin, sans caractère de contrôle, borné
    à 255 caractères (extension conservée). Les accents sont gardés : il ne
    sert qu'à nommer le téléchargement, jamais de chemin sur le disque."""
    nom = (filename or '').replace('\\', '/').rsplit('/', 1)[-1]
    nom = ''.join(c for c in nom if c.isprintable()).strip()
    if len(nom) > NOM_FICHIER_MAX:
        racine, ext = os.path.splitext(nom)
        nom = racine[:NOM_FICHIER_MAX - len(ext)] + ext
    return nom


def valider_fichier(file_storage):
    """Lit et contrôle le fichier envoyé (werkzeug FileStorage).

    Retourne (contenu, format, nom_original) si valide, sinon
    ({"erreur": ...}, 400) — le premier élément est alors un dict."""
    if not file_storage or not getattr(file_storage, 'filename', None):
        return {"erreur": "Aucun fichier reçu"}, 400

    nom = _nom_affichage(file_storage.filename)
    extension = os.path.splitext(nom)[1].lower().lstrip('.')
    if extension not in FORMAT_PAR_EXTENSION:
        return {"erreur": MESSAGE_FORMATS}, 400

    contenu = file_storage.read(EPREUVE_TAILLE_MAX + 1)
    if len(contenu) > EPREUVE_TAILLE_MAX:
        return {"erreur": "Fichier trop volumineux (15 Mo maximum)"}, 400
    if not contenu:
        return {"erreur": "Le fichier est vide"}, 400

    detecte = format_detecte(contenu)
    if detecte is None:
        return {"erreur": MESSAGE_FORMATS}, 400
    if FORMAT_PAR_EXTENSION[extension] != detecte:
        return {"erreur": "L'extension du fichier ne correspond pas à son contenu"}, 400

    return contenu, detecte, nom


# ---------------------------------------------------------------------------
# Stockage sur disque
# ---------------------------------------------------------------------------

def epreuves_dir_of(etablissement_id):
    return os.path.join(current_app.config['EPREUVES_STORAGE_PATH'], str(int(etablissement_id)))


def chemin_epreuve(epreuve):
    """Chemin absolu du fichier de l'épreuve, ou None si le fichier a disparu
    du disque."""
    if not epreuve or not epreuve.fichier:
        return None
    chemin = os.path.join(epreuves_dir_of(epreuve.etablissement_id), os.path.basename(epreuve.fichier))
    return chemin if os.path.isfile(chemin) else None


def delete_epreuve_file(etablissement_id, filename):
    """Best-effort, ne lève jamais (même logique que delete_photo_file)."""
    if not filename:
        return
    chemin = os.path.join(epreuves_dir_of(etablissement_id), os.path.basename(filename))
    if os.path.isfile(chemin):
        try:
            os.remove(chemin)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Lecture : requête de base jointe (classe, matière, enseignant) pour ne pas
# déclencher une requête par ligne, et pagination côté serveur.
# ---------------------------------------------------------------------------

def _classe_label(cycle_libelle, option, classe_id):
    """Même règle que evaluation_api._classe_label : cycle + option
    (ex. « 6ème A »)."""
    if cycle_libelle and option:
        return f"{cycle_libelle} {option}"
    return cycle_libelle or option or f"Classe #{classe_id}"


_COLONNES = (
    Epreuve, MatiereClasse.classe_id, MatiereClasse.matiere_id, Matiere.libelle,
    Cycle.libelle, Classe.option, Enseignant.nom, Enseignant.prenom,
)


def _requete_base(etablissement_id):
    return (
        db.session.query(Epreuve)
        .join(MatiereClasse, MatiereClasse.id == Epreuve.matiere_classe_id)
        .join(Matiere, Matiere.id == MatiereClasse.matiere_id)
        .join(Classe, Classe.id == MatiereClasse.classe_id)
        .join(Cycle, Cycle.id == Classe.cycle_id)
        .join(Enseignant, Enseignant.id == Epreuve.enseignant_id)
        .filter(Epreuve.etablissement_id == etablissement_id)
    )


def _ligne_vers_dict(ligne):
    epreuve, classe_id, matiere_id, matiere_libelle, cycle_libelle, option, nom, prenom = ligne
    data = epreuve.to_dict()
    data.update({
        'classe_id': classe_id,
        'classe_label': _classe_label(cycle_libelle, option, classe_id),
        'matiere_id': matiere_id,
        'matiere_libelle': matiere_libelle,
        'enseignant_nom': f"{nom} {prenom}".strip(),
    })
    return data


def lister_epreuves(etablissement_id, page=1, per_page=10, classe_id=None, matiere_id=None,
                    enseignant_id=None, annee_scolaire_id=None):
    """Liste paginée, de la plus récente à la plus ancienne.

    Retourne {items, total, page, pages, per_page}. `page` est ramenée dans
    [1, pages] (une page trop grande renvoie la dernière, jamais une erreur),
    `pages` vaut au moins 1 (une liste vide s'affiche « page 1 sur 1 »).
    `per_page` est borné à PER_PAGE_MAX."""
    per_page = min(max(per_page or 1, 1), PER_PAGE_MAX)

    base = _requete_base(etablissement_id)
    if classe_id:
        base = base.filter(MatiereClasse.classe_id == classe_id)
    if matiere_id:
        base = base.filter(MatiereClasse.matiere_id == matiere_id)
    if enseignant_id:
        base = base.filter(Epreuve.enseignant_id == enseignant_id)
    if annee_scolaire_id:
        base = base.filter(Epreuve.annee_scolaire_id == annee_scolaire_id)

    total = base.count()
    pages = max(1, math.ceil(total / per_page))
    page = min(max(page or 1, 1), pages)

    lignes = (
        base.with_entities(*_COLONNES)
        .order_by(Epreuve.created_at.desc(), Epreuve.id.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    return {
        'items': [_ligne_vers_dict(ligne) for ligne in lignes],
        'total': total,
        'page': page,
        'pages': pages,
        'per_page': per_page,
    }


def get_epreuve_scoped(epreuve_id, etablissement_id, enseignant_id=None):
    """L'épreuve si elle appartient à l'établissement (et, côté enseignant, à
    cet enseignant), sinon None — l'appelant répond 404, sans distinguer
    « n'existe pas » de « n'est pas à vous »."""
    query = Epreuve.query.filter_by(id=epreuve_id, etablissement_id=etablissement_id)
    if enseignant_id is not None:
        query = query.filter_by(enseignant_id=enseignant_id)
    return query.first()


def epreuve_en_dict(epreuve):
    """Épreuve enrichie (classe, matière, enseignant), au format des listes."""
    ligne = (
        _requete_base(epreuve.etablissement_id)
        .filter(Epreuve.id == epreuve.id)
        .with_entities(*_COLONNES)
        .first()
    )
    return _ligne_vers_dict(ligne) if ligne else epreuve.to_dict()


# ---------------------------------------------------------------------------
# Écriture
# ---------------------------------------------------------------------------

def _entier(valeur):
    """int strict ou None : refuse les booléens, les décimaux, les chaînes non
    numériques (les champs d'un multipart arrivent tous en texte)."""
    if isinstance(valeur, bool):
        return None
    try:
        return int(str(valeur).strip())
    except (TypeError, ValueError):
        return None


def _resoudre_matiere_classe(etablissement_id, form, enseignant_id):
    """MatiereClasse visée par le dépôt : par matiere_classe_id, ou à défaut
    par le couple classe_id + matiere_id (ce que choisit l'administration dans
    la fenêtre d'ajout). Toujours limitée à l'établissement ; pour un
    enseignant, aux SEULES matières-classe qui lui sont attribuées.

    Retourne (matiere_classe, None) ou (None, (dict_erreur, status))."""
    mc_id = _entier(form.get('matiere_classe_id'))
    classe_id = _entier(form.get('classe_id'))
    matiere_id = _entier(form.get('matiere_id'))

    query = (
        MatiereClasse.query
        .join(Classe, Classe.id == MatiereClasse.classe_id)
        .filter(Classe.etablissement_id == etablissement_id)
    )
    if mc_id is not None:
        query = query.filter(MatiereClasse.id == mc_id)
    elif classe_id is not None and matiere_id is not None:
        query = query.filter(MatiereClasse.classe_id == classe_id, MatiereClasse.matiere_id == matiere_id)
    else:
        return None, ({"erreur": "matiere_classe_id (ou classe_id et matiere_id) requis"}, 400)

    if enseignant_id is not None:
        # Enseignant : tout ce qui n'est pas à lui — matière d'un collègue,
        # d'un autre établissement, ou inexistante — donne le même refus.
        query = query.filter(MatiereClasse.enseignant_id == enseignant_id)
        mc = query.first()
        if mc is None:
            return None, ({"erreur": "Cette matière ne vous est pas attribuée dans cette classe"}, 403)
        return mc, None

    mc = query.first()
    if mc is None:
        return None, ({"erreur": "Matière non enseignée dans cette classe"}, 404)
    return mc, None


def deposer_epreuve(etablissement_id, form, file_storage, enseignant_id=None):
    """Dépose une épreuve.

    - enseignant_id renseigné (espace enseignant) : la matière-classe doit être
      la sienne, sinon 403 ;
    - enseignant_id None (administration) : toute matière-classe de
      l'établissement ; l'enseignant de l'épreuve est celui de la
      MatiereClasse.

    `form` est le formulaire multipart (titre + matiere_classe_id, ou
    classe_id + matiere_id). L'établissement vient toujours du JWT / du
    contexte SuperAdmin, jamais du formulaire. Retourne (dict, status)."""
    titre = (form.get('titre') or '').strip()
    if not titre:
        return {"erreur": "Le titre est requis"}, 400
    if len(titre) > TITRE_MAX:
        return {"erreur": f"Le titre ne doit pas dépasser {TITRE_MAX} caractères"}, 400

    mc, erreur = _resoudre_matiere_classe(etablissement_id, form, enseignant_id)
    if erreur:
        return erreur

    annee = annee_active(etablissement_id)
    if annee is None:
        return {"erreur": "Aucune année scolaire n'est définie pour cet établissement"}, 400

    resultat = valider_fichier(file_storage)
    if isinstance(resultat[0], dict):
        return resultat
    contenu, fmt, nom_original = resultat

    dossier = epreuves_dir_of(etablissement_id)
    filename = f"{uuid.uuid4().hex}.{fmt}"
    try:
        os.makedirs(dossier, exist_ok=True)
        with open(os.path.join(dossier, filename), 'wb') as f:
            f.write(contenu)
    except OSError:
        delete_epreuve_file(etablissement_id, filename)
        return {"erreur": "Impossible d'enregistrer le fichier"}, 500

    epreuve = Epreuve(
        etablissement_id=etablissement_id,
        matiere_classe_id=mc.id,
        enseignant_id=mc.enseignant_id,
        annee_scolaire_id=annee.id,
        titre=titre,
        nom_original=nom_original,
        fichier=filename,
        mime=MIME_PAR_FORMAT[fmt],
        taille=len(contenu),
    )
    db.session.add(epreuve)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        delete_epreuve_file(etablissement_id, filename)
        return {"erreur": "Impossible d'enregistrer l'épreuve"}, 500
    return epreuve_en_dict(epreuve), 201


def supprimer_epreuve(epreuve):
    etablissement_id, fichier = epreuve.etablissement_id, epreuve.fichier
    try:
        db.session.delete(epreuve)
        db.session.commit()
    except Exception:
        db.session.rollback()
        return {"erreur": "Erreur lors de la suppression"}, 500
    delete_epreuve_file(etablissement_id, fichier)
    return {"message": "Supprimé avec succès"}, 200
