"""Lecture générique des fichiers d'archives (CSV, Excel, Word) en vue d'un
import de masse.

Chaque établissement a ses propres fichiers : colonnes nommées et ordonnées
différemment, titres et logos au-dessus du tableau, plusieurs tableaux par
document (une classe par tableau), en-têtes répétés, lignes vides... Ce module
ne connaît RIEN des élèves : il transforme n'importe quel fichier en une liste
de « blocs » homogènes que les services d'import (import_eleves_services.py,
et demain enseignants, matières...) interprètent ensuite.

Un bloc = un tableau du fichier :
    {
      "source":   "LISTE MACO 2.docx · tableau 1",
      "contexte": "LISTE PROVISOIRES DES ELEVES MACO 2",   # titre au-dessus
      "entetes":  ["N°", "NOMS ET PRENOMS", "MATRICULE", ...],
      "lignes":   [["1", "ABALA MBOUNDA JOSEPH", "250237775", ...], ...],
      "numeros":  [3, 4, ...],   # n° de ligne d'origine (pour les messages)
      "entete_heritee": False,
    }

Bibliothèques : csv (standard), openpyxl, xlrd, python-docx — toutes libres
et gratuites.
"""

import csv
import io
import os
import re
import unicodedata
from datetime import date, datetime, time
from difflib import SequenceMatcher

MAX_LIGNES = 20000
MAX_COLONNES = 60
# Lignes examinées en tête de tableau pour trouver la ligne d'en-tête.
FENETRE_ENTETE = 15

EXTENSIONS = {'.csv', '.txt', '.tsv', '.xlsx', '.xlsm', '.xls', '.docx'}


class ErreurLecture(Exception):
    """Fichier illisible : le message est destiné à l'utilisateur final."""


# ---------------------------------------------------------------------------
# Normalisation de texte (partagée avec les services d'import)
# ---------------------------------------------------------------------------

def sans_accents(texte):
    texte = unicodedata.normalize('NFKD', str(texte))
    return ''.join(c for c in texte if not unicodedata.combining(c))


def normaliser(texte):
    """« N° d'ordre » -> « n d ordre » : minuscules, sans accents ni ponctuation."""
    texte = sans_accents(texte or '').lower()
    texte = re.sub(r'[^a-z0-9]+', ' ', texte)
    return texte.strip()


def nettoyer_cellule(valeur):
    """Valeur brute (str, nombre, date...) -> texte propre sur une ligne."""
    if valeur is None:
        return ''
    if isinstance(valeur, datetime):
        if valeur.time() == time(0, 0):
            return valeur.date().isoformat()
        return valeur.isoformat(sep=' ')
    if isinstance(valeur, date):
        return valeur.isoformat()
    if isinstance(valeur, bool):
        return 'Oui' if valeur else 'Non'
    if isinstance(valeur, float):
        # Excel stocke les matricules / téléphones en nombres : 250237775.0
        if valeur.is_integer():
            return str(int(valeur))
        return repr(valeur)
    texte = str(valeur).replace(' ', ' ').replace('​', '')
    texte = re.sub(r'\s+', ' ', texte)
    return texte.strip()


# ---------------------------------------------------------------------------
# Détection de la ligne d'en-tête
# ---------------------------------------------------------------------------

def _ressemble_a_une_donnee(cellule):
    """Une cellule d'en-tête est du texte court ; une date, un nombre long ou
    un e-mail trahissent une ligne de données."""
    if not cellule:
        return False
    if re.fullmatch(r'[\d\s/.\-:+]{4,}', cellule):
        return True
    return '@' in cellule


def score_entete(ligne, est_mot_cle):
    """Nombre de cellules reconnues comme intitulés de colonnes, pénalisé
    par les cellules qui ressemblent à des données."""
    score = 0
    for cellule in ligne:
        if not cellule:
            continue
        if _ressemble_a_une_donnee(cellule):
            score -= 1
        elif est_mot_cle(cellule):
            score += 1
    return score


def _dedoublonner(entetes):
    vus = {}
    resultat = []
    for i, nom in enumerate(entetes):
        nom = nom or f'Colonne {i + 1}'
        if nom in vus:
            vus[nom] += 1
            nom = f'{nom} ({vus[nom]})'
        else:
            vus[nom] = 1
        resultat.append(nom)
    return resultat


def _est_ligne_vide(ligne):
    return not any(ligne)


def _est_ligne_numero_seul(ligne):
    """Lignes pré-numérotées mais vides (« 3 | | | | ») des listes Word."""
    remplies = [c for c in ligne if c]
    return len(remplies) == 1 and re.fullmatch(r'\d{1,4}\.?', remplies[0]) is not None


def structurer_tableau(lignes_brutes, est_mot_cle, precedent=None):
    """Repère l'en-tête d'un tableau brut et sépare titres / en-tête / données.

    precedent : bloc précédent du même fichier. Les listes Word découpées en
    plusieurs tableaux (une classe par tableau) ne répètent souvent qu'une
    partie de l'en-tête, voire aucun : on complète alors avec celui du
    tableau précédent s'il a la même largeur.

    Retourne (titres, entetes_brutes, lignes, numeros, entete_heritee) ; les
    colonnes vides sont retirées ensuite par _retirer_colonnes_vides."""
    largeur = max((len(l) for l in lignes_brutes), default=0)
    largeur = min(largeur, MAX_COLONNES)
    lignes = [(list(l) + [''] * largeur)[:largeur] for l in lignes_brutes]
    if not largeur:
        return [], [], [], [], False

    meilleur, idx_entete = 0, None
    for i, ligne in enumerate(lignes[:FENETRE_ENTETE]):
        s = score_entete(ligne, est_mot_cle)
        if s > meilleur:
            meilleur, idx_entete = s, i
    # Un seul intitulé reconnu suffit pour un tableau étroit (≤ 3 colonnes).
    seuil = 1 if largeur <= 3 else 2

    entetes_precedentes = None
    if precedent and len(precedent['_entetes_brutes']) == largeur:
        entetes_precedentes = precedent['_entetes_brutes']

    if idx_entete is None or meilleur < seuil:
        if entetes_precedentes:
            titres = []
            debut = 0
            # Lignes de titre (texte sur une seule cellule) avant les données.
            while debut < len(lignes) and len([c for c in lignes[debut] if c]) == 1 \
                    and not _est_ligne_numero_seul(lignes[debut]):
                titres.append(lignes[debut][0] or next(c for c in lignes[debut] if c))
                debut += 1
            donnees = lignes[debut:]
            numeros = list(range(debut + 1, len(lignes) + 1))
            return titres, list(entetes_precedentes), donnees, numeros, True
        entetes = [f'Colonne {j + 1}' for j in range(largeur)]
        return [], entetes, lignes, list(range(1, len(lignes) + 1)), False

    entete = list(lignes[idx_entete])
    debut = idx_entete + 1
    # En-tête sur deux lignes (« DATE ET LIEU DE NAISSANCE » fusionné au-dessus
    # de « DATE | LIEU ») : la sous-ligne complète ou précise l'intitulé.
    if debut < len(lignes):
        sous = lignes[debut]
        # Au moins deux cases, toutes des intitulés connus : sinon c'est la
        # première ligne de données (« Matières scientifiques » dans une
        # colonne Groupe ressemble à un intitulé) ou un titre de groupe.
        if sum(1 for c in sous if c) >= 2 and all(est_mot_cle(c) for c in sous if c) \
                and not any(_ressemble_a_une_donnee(c) for c in sous):
            entete = [s if s else e for e, s in zip(entete, sous)]
            debut += 1

    heritee = False
    if entetes_precedentes:
        for j, nom in enumerate(entete):
            if not nom:
                entete[j] = entetes_precedentes[j]
                heritee = True

    titres = []
    for ligne in lignes[:idx_entete]:
        texte = ' '.join(c for c in ligne if c)
        if texte:
            titres.append(texte)

    entetes = _dedoublonner(entete)
    entete_norm = [normaliser(c) for c in entete]
    donnees, numeros = [], []
    for k, ligne in enumerate(lignes[debut:], start=debut + 1):
        # En-tête répété en haut de chaque page.
        if [normaliser(c) for c in ligne] == entete_norm:
            continue
        donnees.append(ligne)
        numeros.append(k)
    return titres, entetes, donnees, numeros, heritee


def _retirer_colonnes_vides(entetes, lignes):
    """Colonnes sans intitulé ni donnée (bordures, cellules fusionnées)."""
    utiles = [j for j, nom in enumerate(entetes)
              if not re.fullmatch(r'Colonne \d+', nom) or any(l[j] for l in lignes)]
    return [entetes[j] for j in utiles], [[l[j] for j in utiles] for l in lignes]


def _filtrer_lignes(lignes, numeros):
    """Retire lignes vides, lignes pré-numérotées vides et lignes de total."""
    garde_l, garde_n = [], []
    for ligne, num in zip(lignes, numeros):
        if _est_ligne_vide(ligne) or _est_ligne_numero_seul(ligne):
            continue
        premiere = normaliser(next((c for c in ligne if c), ''))
        if re.match(r'^(total|effectif|sous total|nombre d eleves|arrete la presente)', premiere):
            continue
        garde_l.append(ligne)
        garde_n.append(num)
    return garde_l, garde_n


# ---------------------------------------------------------------------------
# Lecteurs par format
# ---------------------------------------------------------------------------

def _decoder(contenu):
    for encodage in ('utf-8-sig', 'cp1252', 'latin-1'):
        try:
            return contenu.decode(encodage)
        except UnicodeDecodeError:
            continue
    raise ErreurLecture("Encodage du fichier texte non reconnu.")


def _separateur(texte):
    echantillon = [l for l in texte.splitlines()[:30] if l.strip()]
    meilleur, score_max = ',', -1
    for sep in (';', '\t', ',', '|'):
        comptes = [l.count(sep) for l in echantillon]
        if not comptes or max(comptes) == 0:
            continue
        # Un bon séparateur apparaît souvent ET de façon régulière.
        frequent = max(set(comptes), key=comptes.count)
        score = comptes.count(frequent) * frequent
        if score > score_max:
            meilleur, score_max = sep, score
    return meilleur


def lire_texte_tabule(texte):
    """CSV / TSV / texte collé depuis Excel -> un tableau brut."""
    sep = _separateur(texte)
    lecteur = csv.reader(io.StringIO(texte), delimiter=sep)
    lignes = []
    for ligne in lecteur:
        lignes.append([nettoyer_cellule(c) for c in ligne])
        if len(lignes) > MAX_LIGNES:
            raise ErreurLecture(f"Fichier trop volumineux (plus de {MAX_LIGNES} lignes).")
    return lignes


def _feuilles_xlsx(contenu):
    try:
        import openpyxl
    except ImportError as exc:  # pragma: no cover
        raise ErreurLecture("Lecture Excel indisponible (openpyxl manquant sur le serveur).") from exc
    try:
        classeur = openpyxl.load_workbook(io.BytesIO(contenu), data_only=True)
    except Exception as exc:
        raise ErreurLecture("Fichier Excel illisible ou protégé par mot de passe.") from exc
    for feuille in classeur.worksheets:
        if feuille.sheet_state != 'visible':
            continue
        # Cellules fusionnées : seule la cellule en haut à gauche porte la
        # valeur, on la recopie sur les lignes d'une fusion verticale.
        fusions = {}
        for plage in feuille.merged_cells.ranges:
            haut = feuille.cell(plage.min_row, plage.min_col).value
            for r in range(plage.min_row + 1, plage.max_row + 1):
                fusions[(r, plage.min_col)] = haut
        lignes = []
        for r, row in enumerate(feuille.iter_rows(values_only=True), start=1):
            if r > MAX_LIGNES:
                raise ErreurLecture(f"Feuille « {feuille.title} » trop volumineuse (plus de {MAX_LIGNES} lignes).")
            valeurs = list(row[:MAX_COLONNES])
            for (fr, fc), v in fusions.items():
                if fr == r and fc - 1 < len(valeurs) and valeurs[fc - 1] in (None, ''):
                    valeurs[fc - 1] = v
            lignes.append([nettoyer_cellule(v) for v in valeurs])
        yield feuille.title, lignes


def _feuilles_xls(contenu):
    try:
        import xlrd
    except ImportError as exc:  # pragma: no cover
        raise ErreurLecture("Lecture des anciens fichiers Excel (.xls) indisponible sur le serveur.") from exc
    try:
        classeur = xlrd.open_workbook(file_contents=contenu)
    except Exception as exc:
        raise ErreurLecture("Fichier Excel (.xls) illisible.") from exc
    for feuille in classeur.sheets():
        if getattr(feuille, 'visibility', 0):
            continue
        lignes = []
        for r in range(min(feuille.nrows, MAX_LIGNES)):
            ligne = []
            for c in range(min(feuille.ncols, MAX_COLONNES)):
                cellule = feuille.cell(r, c)
                v = cellule.value
                if cellule.ctype == xlrd.XL_CELL_DATE:
                    try:
                        v = xlrd.xldate.xldate_as_datetime(v, classeur.datemode)
                    except Exception:
                        pass
                ligne.append(nettoyer_cellule(v))
            lignes.append(ligne)
        yield feuille.name, lignes


def _tableaux_docx(contenu, paragraphes_bruts=None):
    """Tableaux du document dans l'ordre, chacun avec les derniers paragraphes
    non vides qui le précèdent (souvent « LISTE DES ÉLÈVES DE 6e A »).

    paragraphes_bruts : liste remplie avec le texte brut (tabulations
    comprises) de tous les paragraphes hors tableaux, pour extraire_fiches."""
    try:
        import docx
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ImportError as exc:  # pragma: no cover
        raise ErreurLecture("Lecture Word indisponible (python-docx manquant sur le serveur).") from exc
    try:
        document = docx.Document(io.BytesIO(contenu))
    except Exception as exc:
        raise ErreurLecture("Document Word illisible. S'il s'agit d'un ancien fichier .doc, "
                            "ouvrez-le dans Word et enregistrez-le au format .docx.") from exc

    def lire_table(table):
        lignes = []
        for row in table.rows:
            ligne, precedente = [], None
            for cell in row.cells:
                # Fusion horizontale : python-docx renvoie la même cellule
                # plusieurs fois, on ne garde la valeur qu'une fois.
                if precedente is not None and cell._tc is precedente:
                    ligne.append('')
                    continue
                precedente = cell._tc
                texte = ' '.join(p.text for p in cell.paragraphs)
                # Tableau imbriqué dans une cellule : rare, on le résume.
                if cell.tables and not texte.strip():
                    texte = ' '.join(c.text for t in cell.tables for r in t.rows for c in r.cells)
                ligne.append(nettoyer_cellule(texte))
            lignes.append(ligne)
            if len(lignes) > MAX_LIGNES:
                raise ErreurLecture(f"Tableau trop volumineux (plus de {MAX_LIGNES} lignes).")
        return lignes

    paragraphes_recents = []
    for element in document.element.body.iterchildren():
        balise = element.tag.rsplit('}', 1)[-1]
        if balise == 'p':
            brut = Paragraph(element, document).text
            if paragraphes_bruts is not None:
                paragraphes_bruts.append(brut)
            texte = nettoyer_cellule(brut)
            if texte:
                paragraphes_recents = (paragraphes_recents + [texte])[-4:]
        elif balise == 'tbl':
            yield paragraphes_recents, lire_table(Table(element, document))
            paragraphes_recents = []


# ---------------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------------

def _titre_utile(textes):
    """Dernier titre court, en remontant, qui ressemble à un intitulé de
    liste / classe (et pas à « Fait à ..., le » ou à une adresse)."""
    for texte in reversed(textes):
        n = normaliser(texte)
        if not n or len(texte) > 120:
            continue
        if re.search(r'\b(liste|classe|eleves?|effectif|promotion|niveau|section|salle)\b', n):
            return texte
    return ''


def lire_fichier(nom_fichier, contenu, est_mot_cle, fiches=False):
    """Lit un fichier et renvoie ses blocs (cf. docstring du module).

    est_mot_cle(texte) -> bool : indique si un texte est un intitulé de
    colonne connu du module appelant (sert à repérer la ligne d'en-tête).

    fiches : pour un document Word, extrait aussi les fiches rédigées en
    paragraphes « LIBELLÉ : valeur » (une fiche par personne) — cf.
    extraire_fiches."""
    if not contenu:
        raise ErreurLecture("Le fichier est vide.")
    base, ext = os.path.splitext(nom_fichier or '')
    ext = ext.lower()
    if ext == '.doc':
        raise ErreurLecture("Ancien format Word (.doc) : ouvrez le fichier dans Word et "
                            "enregistrez-le au format .docx, puis réessayez.")
    if ext in ('.ods', '.odt'):
        raise ErreurLecture("Format LibreOffice : enregistrez le fichier au format .xlsx ou .docx, puis réessayez.")
    if ext not in EXTENSIONS:
        raise ErreurLecture("Format non pris en charge. Formats acceptés : CSV, Excel (.xlsx, .xls) et Word (.docx).")

    if ext in ('.csv', '.txt', '.tsv'):
        sources = [(base, [], lire_texte_tabule(_decoder(contenu)))]
    elif ext in ('.xlsx', '.xlsm'):
        sources = [(f"{base} · {titre}", [titre], lignes) for titre, lignes in _feuilles_xlsx(contenu)]
    elif ext == '.xls':
        sources = [(f"{base} · {titre}", [titre], lignes) for titre, lignes in _feuilles_xls(contenu)]
    else:
        paragraphes = []
        sources = [(f"{base} · tableau {i}", paras, lignes)
                   for i, (paras, lignes) in enumerate(_tableaux_docx(contenu, paragraphes), start=1)]
        if fiches:
            blocs = construire_blocs(nom_fichier, base, sources, est_mot_cle)
            bloc_fiches = extraire_fiches(paragraphes, est_mot_cle)
            if bloc_fiches:
                bloc_fiches.update({'source': f"{base} · fiches", 'fichier': nom_fichier, 'fichier_base': base})
                blocs.insert(0, bloc_fiches)
            return blocs

    return construire_blocs(nom_fichier, base, sources, est_mot_cle)


# ---------------------------------------------------------------------------
# Fiches rédigées en paragraphes (« NOMS ET PRENOMS : Mme ABENG »)
# ---------------------------------------------------------------------------

# Séparateur de zones sur une ligne : plusieurs tabulations, ou une
# tabulation accolée à une longue suite d'espaces.
_SEP_ZONES = re.compile(r'\t[ \t]*\t|\t {3,}| {3,}\t| {6,}')
_LIBELLE_VALEUR = re.compile(r'^\s*([^\d:\t]{2,45}?)\s*:\s*(.*)$', re.S)


def _segments(texte):
    texte = texte.replace('\u00a0', ' ')
    for zone in _SEP_ZONES.split(texte):
        # « GRADE : PLET\tCONTACT : 6965... » : une seule tabulation, mais
        # suivie d'un nouveau « LIBELLÉ : ».
        for morceau in re.split(r'\t(?=[^\d:\t]{2,45}:)', zone):
            if morceau.strip():
                yield morceau.strip()


def _libelle_valeur(segment, est_mot_cle):
    m = _LIBELLE_VALEUR.match(segment)
    if m:
        return m.group(1), m.group(2)
    # « GRADE PLET » (deux-points oublié) : libellé connu en début de segment.
    mots = segment.split()
    for k in range(min(4, len(mots) - 1), 0, -1):
        libelle = ' '.join(mots[:k])
        if est_mot_cle(libelle):
            return libelle, ' '.join(mots[k:])
    return None, None


def _cle_fiche(cle, connues):
    """Rattache un libellé mal saisi à un libellé déjà vu dans le document
    (« NOMS ET PRENOM » -> « NOMS ET PRENOMS », « GRAD » -> « GRADE »,
    « HEURESFAITES » -> « HEURES FAITES »)."""
    compacte = cle.replace(' ', '')
    for connue in connues:
        autre = connue.replace(' ', '')
        if compacte == autre or SequenceMatcher(None, compacte, autre).ratio() >= 0.85:
            return connue
    return cle


def extraire_fiches(paragraphes, est_mot_cle):
    """Une fiche par personne, écrite en paragraphes « LIBELLÉ : valeur »
    (plusieurs paires par ligne, séparées par des tabulations). Seuls les
    libellés reconnus par le module sont retenus ; une nouvelle fiche
    commence quand un libellé déjà vu réapparaît. -> bloc ou None."""
    fiches, courante, ordre, libelles = [], {}, [], {}
    for texte in paragraphes:
        for segment in _segments(texte or ''):
            libelle, valeur = _libelle_valeur(segment, est_mot_cle)
            if not libelle or not est_mot_cle(libelle):
                continue
            cle = _cle_fiche(normaliser(libelle), ordre)
            if cle in courante:
                fiches.append(courante)
                courante = {}
            courante[cle] = nettoyer_cellule(valeur)
            if cle not in libelles:
                libelles[cle] = nettoyer_cellule(libelle)
                ordre.append(cle)
    if courante:
        fiches.append(courante)
    fiches = [f for f in fiches if sum(1 for v in f.values() if v) >= 2]
    if len(fiches) < 2 and not (fiches and len(fiches[0]) >= 3):
        return None
    if len(fiches) > MAX_LIGNES:
        raise ErreurLecture(f"Document trop volumineux (plus de {MAX_LIGNES} fiches).")
    return {
        'contexte': '',
        'entetes': [libelles[c] for c in ordre],
        'lignes': [[f.get(c, '') for c in ordre] for f in fiches],
        'numeros': list(range(1, len(fiches) + 1)),
        'entete_heritee': False,
    }


def construire_blocs(nom_fichier, base, sources, est_mot_cle):
    blocs = []
    precedent = None
    for source, textes_avant, brut in sources:
        titres, entetes_brutes, lignes, numeros, heritee = structurer_tableau(brut, est_mot_cle, precedent)
        lignes, numeros = _filtrer_lignes(lignes, numeros)
        if not lignes:
            continue
        entetes, lignes = _retirer_colonnes_vides(entetes_brutes, lignes)
        # Noms de feuille par défaut (« Feuil1 », « Sheet1 ») : non significatifs.
        textes_avant = [t for t in textes_avant if not re.fullmatch(r'(feuil|sheet|feuille)\s*\d*', normaliser(t))]
        contexte = _titre_utile(titres) or _titre_utile(textes_avant) \
            or (textes_avant[-1] if textes_avant and len(textes_avant[-1]) <= 40 else '')
        bloc = {
            'source': source,
            'fichier': nom_fichier,
            'fichier_base': base,
            'contexte': contexte,
            'entetes': entetes,
            'lignes': lignes,
            'numeros': numeros,
            'entete_heritee': heritee,
            '_entetes_brutes': entetes_brutes,
        }
        blocs.append(bloc)
        precedent = bloc
    for bloc in blocs:
        del bloc['_entetes_brutes']
    return blocs
