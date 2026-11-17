"""
Remplit l'établissement « COLLEGE LAURA » (mode d'évaluation Collège : CC 30 %
+ DS 70 % par séquence) avec une simulation réaliste d'un collège privé de
Douala (Ndogbong), année 2026-2027.

Usage :
    python seed_college_laura.py

- 2 cycles, 7 niveaux, 2 classes par niveau (14 classes), 50 à 56 élèves par
  classe ;
- matières et coefficients du programme camerounais, tous les cours confiés
  à un enseignant (avec compte de connexion), un titulaire par classe ;
- emploi du temps complet (toutes les heures placées, sans collision classe
  ni enseignant), du lundi au vendredi, mercredi après-midi libre ;
- notes CC + DS des séquences 1 et 2 ; dans chaque classe, 3 élèves n'ont
  AUCUNE note dans 3 matières (trous à traiter avant bulletin / PV) ;
- discipline des séquences 1 et 2 ; échéancier et paiements de scolarité
  (espèces, Orange Money / MTN MoMo, virement, chèque), avec retards.

L'audit est débranché pendant le remplissage (ce n'est pas une action
d'utilisateur). Le script refuse de tourner si LAURA a déjà des classes.
Les codes et PIN des comptes créés sont écrits dans ACCES_COLLEGE_LAURA.txt
(racine du projet et Téléchargements) : seule trace des PIN en clair.
"""

import random
import sys
import unicodedata
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from app import create_app

app = create_app()

from sqlalchemy import event
from sqlalchemy.orm import Session

from extensions import db
from services import audit_services
from models.authentification_models import Role, Utilisateur, generate_temp_pin
from models.structure_models import Etablissement, Cycle, Niveau, Classe, AnneeScolaire, Trimestre, Sequence
from models.pedagogie_models import (
    GroupeMatiere, Matiere, Departement, Grade, Enseignant, Censeur, Surveillant,
    TitulaireClasse, MatiereClasse, CenseurClasse, SurveillantClasse,
)
from models.inscription_models import Parent, Eleve, Inscription
from models.evaluation_models import Note, Discipline
from models.emploi_du_temps_models import CreneauHoraire, Horaire
from models.paiements_models import TrancheClasse, Paiement, LignePaiement
from services.tresorerie_services import initialiser_tresorerie

random.seed(20261117)

NOM_ETAB = 'COLLEGE LAURA'
DOMAINE = 'collegelaura.example.com'
ANNEE = '2026-2027'
FICHIERS_ACCES = [CURRENT_DIR.parent / 'ACCES_COLLEGE_LAURA.txt',
                  Path.home() / 'Downloads' / 'ACCES_COLLEGE_LAURA.txt']
MAINTENANT = datetime(2026, 11, 17, 9, 0)

# ── Noms (Douala : Sawa, Bassa, Bamiléké, Béti, Nord) ────────────────────

NOMS = [
    'EBOA', 'DIKOBO', 'EKWALLA', 'NDOUMBE', 'MOUKOKO', 'PRISO', 'EBANDA', 'KOTTO', 'EYIDI', 'DIBONGUE',
    'NGOUE', 'EPEE', 'MBAPE', 'DOUALA MANGA', 'ESSAKA', 'MOUANGUE', 'NJOH', 'EKAMBI', 'ELESSA', 'MBELLA',
    'NDJOCK', 'BAYIHA', 'MBOG', 'NYOBE', 'BIKOK', 'NLEND', 'MAHOP', 'NGOS', 'BOT', 'MANDENG',
    'FOTSO', 'KAMGA', 'TCHOUPO', 'KENFACK', 'TAGNE', 'DJOMO', 'NOUBISSI', 'DONGMO', 'TCHINDA', 'FEUDJIO',
    'NGANKAM', 'TAKAM', 'WAFO', 'SIMO', 'YOUMBI', 'NGUEMO', 'TCHAMBA', 'POUOKAM', 'MOUAFO', 'KUATE',
    'MBARGA', 'ATANGANA', 'ESSOMBA', 'ONANA', 'MVONDO', 'FOUDA', 'OWONA', 'NKOULOU', 'ZAMBO', 'AMOUGOU',
    'BELLO', 'HAMADOU', 'ALIOU', 'MOUSSA', 'OUMAROU', 'NJOYA', 'MFOUAPON', 'NJIKAM', 'NCHARE', 'MOLUH',
]
PRENOMS_M = [
    'Jean', 'Paul', 'Samuel', 'Emmanuel', 'Joseph', 'Daniel', 'Christian', 'Junior', 'Arnaud', 'Brice',
    'Cédric', 'Franck', 'Hervé', 'Loïc', 'Yannick', 'Steve', 'Boris', 'Ibrahim', 'Kevin', 'Willy',
    'Rodrigue', 'Serge', 'Ulrich', 'Landry', 'Fabrice', 'Achille', 'Blaise', 'Gaël', 'Ivan', 'Dimitri',
    'Ange', 'Wilfried', 'Jordan', 'Ryan', 'Nathan', 'Enzo', 'Marcel', 'Herman', 'Duplex', 'Aurélien',
]
PRENOMS_F = [
    'Marie', 'Grâce', 'Sandrine', 'Christelle', 'Larissa', 'Murielle', 'Nadège', 'Rachel', 'Esther', 'Josiane',
    'Carine', 'Aïcha', 'Vanessa', 'Laure', 'Joëlle', 'Ornella', 'Prisca', 'Merveille', 'Sylvie', 'Edwige',
    'Clarisse', 'Diane', 'Inès', 'Mireille', 'Raïssa', 'Stéphanie', 'Manuela', 'Darelle', 'Audrey', 'Linda',
    'Belinda', 'Gwladys', 'Annick', 'Flore', 'Noëlle', 'Divine', 'Patience', 'Kelly', 'Cynthia', 'Estelle',
]
LIEUX = ['Douala'] * 14 + ['Yaoundé', 'Bafoussam', 'Nkongsamba', 'Edéa', 'Limbé', 'Buea', 'Loum', 'Dschang', 'Kribi', 'Mbanga']

# ── Matières : libellé -> (abréviation, groupe, département) ─────────────

GROUPES = [('Matières littéraires', 1), ('Matières scientifiques', 2), ('Matières complémentaires', 3)]
MATIERES = {
    'Français': ('FRAN', 'Matières littéraires', 'Lettres modernes françaises'),
    'Anglais': ('ANGL', 'Matières littéraires', 'Langues vivantes'),
    'Espagnol': ('ESP', 'Matières littéraires', 'Langues vivantes'),
    'Histoire-Géographie': ('HG', 'Matières littéraires', 'Histoire-Géographie-ECM'),
    'ECM': ('ECM', 'Matières littéraires', 'Histoire-Géographie-ECM'),
    'Philosophie': ('PHILO', 'Matières littéraires', 'Philosophie'),
    'Mathématiques': ('MATHS', 'Matières scientifiques', 'Mathématiques'),
    'SVTEEHB': ('SVT', 'Matières scientifiques', 'SVT'),
    'PCT': ('PCT', 'Matières scientifiques', 'Physique-Chimie-Technologie'),
    'Informatique': ('INFO', 'Matières scientifiques', 'Informatique'),
    'LCN': ('LCN', 'Matières complémentaires', 'Histoire-Géographie-ECM'),
    'EPS': ('EPS', 'Matières complémentaires', 'EPS'),
}
# Famille d'enseignement : un même enseignant prend toutes les matières de
# la famille dans une classe (le professeur d'histoire-géo fait l'ECM et la LCN).
FAMILLE = {'Histoire-Géographie': 'HG', 'ECM': 'HG', 'LCN': 'HG'}

# programme : matière -> (coefficient, heures / semaine)
PROGRAMMES = {
    '6e5e': {'Français': (5, 6), 'Anglais': (3, 4), 'Histoire-Géographie': (2, 3), 'ECM': (1, 1), 'LCN': (1, 1),
             'Mathématiques': (4, 5), 'SVTEEHB': (2, 2), 'PCT': (2, 2), 'Informatique': (1, 2), 'EPS': (2, 2)},
    '4e3e': {'Français': (5, 5), 'Anglais': (3, 4), 'Espagnol': (2, 3), 'Histoire-Géographie': (2, 3), 'ECM': (1, 1),
             'Mathématiques': (4, 5), 'SVTEEHB': (2, 2), 'PCT': (2, 3), 'Informatique': (1, 2), 'EPS': (2, 2)},
    '2ndeA': {'Français': (4, 5), 'Anglais': (3, 4), 'Espagnol': (3, 4), 'Histoire-Géographie': (3, 3), 'ECM': (1, 1),
              'Mathématiques': (3, 4), 'SVTEEHB': (2, 2), 'PCT': (2, 2), 'Informatique': (2, 2), 'EPS': (2, 2)},
    '2ndeC': {'Français': (3, 4), 'Anglais': (2, 3), 'Espagnol': (2, 2), 'Histoire-Géographie': (2, 3), 'ECM': (1, 1),
              'Mathématiques': (5, 6), 'PCT': (4, 5), 'SVTEEHB': (2, 3), 'Informatique': (2, 2), 'EPS': (2, 2)},
    '1ereA': {'Français': (4, 5), 'Philosophie': (2, 3), 'Anglais': (3, 4), 'Espagnol': (3, 3),
              'Histoire-Géographie': (3, 3), 'ECM': (1, 1), 'Mathématiques': (2, 3), 'SVTEEHB': (2, 2),
              'Informatique': (2, 2), 'EPS': (2, 2)},
    '1ereD': {'Français': (3, 3), 'Philosophie': (2, 2), 'Anglais': (2, 3), 'Histoire-Géographie': (2, 2), 'ECM': (1, 1),
              'Mathématiques': (4, 5), 'PCT': (4, 5), 'SVTEEHB': (4, 4), 'Informatique': (2, 2), 'EPS': (2, 2)},
    'TleA': {'Philosophie': (5, 6), 'Français': (4, 4), 'Anglais': (3, 3), 'Espagnol': (3, 3),
             'Histoire-Géographie': (3, 3), 'ECM': (1, 1), 'Mathématiques': (2, 2), 'SVTEEHB': (2, 2),
             'Informatique': (1, 2), 'EPS': (2, 2)},
    'TleD': {'Philosophie': (2, 3), 'Français': (2, 3), 'Anglais': (2, 2), 'Histoire-Géographie': (2, 2), 'ECM': (1, 1),
             'Mathématiques': (4, 5), 'PCT': (4, 5), 'SVTEEHB': (5, 5), 'Informatique': (2, 2), 'EPS': (2, 2)},
}

# (cycle, niveau, ordre du niveau, classe, programme, âge)
CLASSES = [
    ('Premier Cycle', '6e', 1, '6e A', '6e5e', 11), ('Premier Cycle', '6e', 1, '6e B', '6e5e', 11),
    ('Premier Cycle', '5e', 2, '5e A', '6e5e', 12), ('Premier Cycle', '5e', 2, '5e B', '6e5e', 12),
    ('Premier Cycle', '4e', 3, '4e A', '4e3e', 13), ('Premier Cycle', '4e', 3, '4e B', '4e3e', 13),
    ('Premier Cycle', '3e', 4, '3e A', '4e3e', 14), ('Premier Cycle', '3e', 4, '3e B', '4e3e', 14),
    ('Second Cycle', '2nde', 5, '2nde A4', '2ndeA', 15), ('Second Cycle', '2nde', 5, '2nde C', '2ndeC', 15),
    ('Second Cycle', '1ère', 6, '1ère A4', '1ereA', 16), ('Second Cycle', '1ère', 6, '1ère D', '1ereD', 16),
    ('Second Cycle', 'Tle', 7, 'Tle A4', 'TleA', 17), ('Second Cycle', 'Tle', 7, 'Tle D', 'TleD', 17),
]

# Horaires : 8 heures par jour, pause 10h15-10h30, déjeuner 12h20-12h50.
CRENEAUX = [
    ('1ère heure', time(7, 30), time(8, 25)), ('2ème heure', time(8, 25), time(9, 20)),
    ('3ème heure', time(9, 20), time(10, 15)), ('4ème heure', time(10, 30), time(11, 25)),
    ('5ème heure', time(11, 25), time(12, 20)), ('6ème heure', time(12, 50), time(13, 45)),
    ('7ème heure', time(13, 45), time(14, 40)), ('8ème heure', time(14, 40), time(15, 35)),
]
JOURS = {'Lundi': 8, 'Mardi': 8, 'Mercredi': 5, 'Jeudi': 8, 'Vendredi': 8}  # nb d'heures du jour
DEBUTS_BLOC = (0, 1, 3, 5, 6)  # heures doubles sans chevaucher pause / déjeuner

TRIMESTRES = [
    ('Trimestre 1', date(2026, 9, 7), date(2026, 12, 18), [
        ('Sequence 1', date(2026, 9, 7), date(2026, 10, 16)),
        ('Sequence 2', date(2026, 10, 19), date(2026, 12, 4)),
    ]),
    ('Trimestre 2', date(2027, 1, 4), date(2027, 3, 26), [
        ('Sequence 3', date(2027, 1, 4), date(2027, 2, 12)),
        ('Sequence 4', date(2027, 2, 15), date(2027, 3, 26)),
    ]),
    ('Trimestre 3', date(2027, 4, 6), date(2027, 6, 11), [
        ('Sequence 5', date(2027, 4, 6), date(2027, 5, 7)),
        ('Sequence 6', date(2027, 5, 10), date(2027, 6, 11)),
    ]),
]

# Échéancier (libellé, ordre, date limite) et tarifs FCFA par cycle.
ECHEANCIER = [("Frais d'inscription", 1, date(2026, 9, 15)), ('1ère tranche', 2, date(2026, 10, 15)),
              ('2ème tranche', 3, date(2027, 1, 15)), ('3ème tranche', 4, date(2027, 3, 31))]
TARIFS = {'Premier Cycle': [25000, 60000, 50000, 40000], 'Second Cycle': [30000, 70000, 60000, 45000]}

CHARGE_CIBLE = 18  # heures / semaine par enseignant

# ── Outils ───────────────────────────────────────────────────────────────

_emails = set()
comptes = []  # dict(role, nom, code, pin, detail)


def sans_accents(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


def email_unique(prenom, nom, domaine=DOMAINE):
    base = sans_accents(f"{prenom.split()[0]}.{nom}").lower().replace(' ', '')
    email, n = f"{base}@{domaine}", 1
    while email in _emails:
        n += 1
        email = f"{base}{n}@{domaine}"
    _emails.add(email)
    return email


def telephone():
    return '6' + random.choice('5789') + ''.join(random.choice('0123456789') for _ in range(7))


_personnes = set()  # pas deux membres du personnel au même nom


def personne(sexe=None, unique=True):
    sexe = sexe or random.choice('MF')
    while True:
        p = (sexe, random.choice(PRENOMS_M if sexe == 'M' else PRENOMS_F), random.choice(NOMS))
        if not unique or p[1:] not in _personnes:
            if unique:
                _personnes.add(p[1:])
            return p


def creer_compte(etab, prenom, nom, email, roles, sexe):
    pin = generate_temp_pin()
    civ = 'M.' if sexe == 'M' else 'Mme'
    u = Utilisateur(etablissement_id=etab.id, nom=f"{civ} {prenom} {nom}", email=email, actif=True,
                    roles=[Role.query.filter_by(libelle=r).one() for r in roles], doit_changer_mdp=False)
    u.set_password(pin)
    db.session.add(u)
    db.session.flush()
    compte = {'role': ', '.join(roles), 'nom': f"{nom} {prenom}", 'code': u.code_connexion, 'pin': pin,
              'tel': None, 'detail': ''}
    comptes.append(compte)
    return u, compte


def get_or_create(model, **kw):
    obj = model.query.filter_by(**kw).first()
    if not obj:
        obj = model(**kw)
        db.session.add(obj)
        db.session.flush()
    return obj


def note_quart(x):
    return Decimal(str(round(max(0.0, min(20.0, x)) * 4) / 4)).quantize(Decimal('0.01'))


def moment(jour, h_min=7, h_max=17):
    return datetime.combine(jour, time(random.randint(h_min, h_max - 1), random.randint(0, 59)))


# ── Structure ────────────────────────────────────────────────────────────

def creer_structure(etab):
    annee = AnneeScolaire(etablissement_id=etab.id, libelle=ANNEE, active=True, mode_evaluation='college')
    db.session.add(annee)
    db.session.flush()
    sequences = []
    for lib, debut, fin, seqs in TRIMESTRES:
        tri = Trimestre(annee_scolaire_id=annee.id, libelle=lib, date_debut=debut, date_fin=fin)
        db.session.add(tri)
        db.session.flush()
        for slib, sdebut, sfin in seqs:
            seq = Sequence(trimestre_id=tri.id, libelle=slib, date_debut=sdebut, date_fin=sfin)
            db.session.add(seq)
            db.session.flush()
            sequences.append(seq)

    cycles, niveaux, classes = {}, {}, []
    for cycle_lib, niv_lib, ordre, option, programme, age in CLASSES:
        if cycle_lib not in cycles:
            cycles[cycle_lib] = get_or_create(Cycle, etablissement_id=etab.id, libelle=cycle_lib)
        if niv_lib not in niveaux:
            niveaux[niv_lib] = get_or_create(Niveau, etablissement_id=etab.id, libelle=niv_lib, ordre=ordre)
        c = Classe(etablissement_id=etab.id, cycle_id=cycles[cycle_lib].id, option=option,
                   niveau_id=niveaux[niv_lib].id)
        db.session.add(c)
        db.session.flush()
        classes.append({'classe': c, 'cycle': cycle_lib, 'niveau': niv_lib, 'programme': PROGRAMMES[programme],
                        'age': age})

    groupes = {lib: get_or_create(GroupeMatiere, etablissement_id=etab.id, libelle=lib, ordre=o) for lib, o in GROUPES}
    matieres, departements = {}, {}
    for lib, (abr, groupe, dep) in MATIERES.items():
        m = Matiere(etablissement_id=etab.id, libelle=lib, groupe_id=groupes[groupe].id, abreviation=abr)
        db.session.add(m)
        if dep not in departements:
            departements[dep] = get_or_create(Departement, etablissement_id=etab.id, libelle=dep)
        matieres[lib] = m
    db.session.flush()
    grades = [get_or_create(Grade, etablissement_id=etab.id, libelle=g) for g in ('PLEG', 'PCEG', 'Vacataire')]
    return annee, sequences, classes, matieres, departements, grades


# ── Enseignants et affectations ──────────────────────────────────────────

def creer_enseignants(etab, classes, matieres, departements, grades):
    """Regroupe les cours par famille (matière, ou HG+ECM+LCN), répartit les
    classes d'une famille entre ceil(total / CHARGE_CIBLE) enseignants en
    gardant ensemble les classes parallèles, puis crée les MatiereClasse."""
    lots = {}  # famille -> [(info classe, [matières])]
    for info in classes:
        par_famille = {}
        for lib in info['programme']:
            par_famille.setdefault(FAMILLE.get(lib, lib), []).append(lib)
        for fam, libs in par_famille.items():
            lots.setdefault(fam, []).append((info, libs))

    enseignants = []
    for fam, items in lots.items():
        total = sum(info['programme'][l][1] for info, libs in items for l in libs)
        n = max(1, -(-total // CHARGE_CIBLE))
        cible = total / n
        dep = departements[MATIERES[items[0][1][0]][2]]
        profs = []
        for _ in range(n):
            sexe, prenom, nom = personne()
            email = email_unique(prenom, nom)
            u, compte = creer_compte(etab, prenom, nom, email, ['Enseignant'], sexe)
            grade = random.choices(grades, weights=[5, 3, 2])[0]
            ens = Enseignant(etablissement_id=etab.id, nom=nom, prenom=prenom, telephone=telephone(), email=email,
                             sexe=sexe, departement_id=dep.id, grade_id=grade.id, utilisateur_id=u.id)
            db.session.add(ens)
            db.session.flush()
            compte['tel'] = ens.telephone
            p = {'ens': ens, 'compte': compte, 'heures': 0, 'cours': [], 'grade': grade.libelle,
                 'departement': dep.libelle}
            profs.append(p)
            enseignants.append(p)
        k = 0
        for info, libs in items:  # items dans l'ordre des niveaux : classes parallèles côte à côte
            h = sum(info['programme'][l][1] for l in libs)
            if profs[k]['heures'] + h / 2 > cible and k < n - 1:
                k += 1
            prof = profs[k]
            for lib in libs:
                coef, _ = info['programme'][lib]
                mc = MatiereClasse(classe_id=info['classe'].id, matiere_id=matieres[lib].id,
                                   enseignant_id=prof['ens'].id, coefficient=coef)
                db.session.add(mc)
                db.session.flush()
                info.setdefault('mcs', []).append({'mc': mc, 'lib': lib, 'heures': info['programme'][lib][1],
                                                   'prof': prof})
            prof['heures'] += h
            prof['cours'].append(f"{'/'.join(libs)} {info['classe'].option}")
    return enseignants


def creer_titulaires(classes, annee, enseignants):
    pris = set()
    for info in classes:
        # Le professeur qui a le plus d'heures dans la classe, libre de préférence.
        candidats = sorted(info['mcs'], key=lambda m: -m['heures'])
        choix = next((m['prof'] for m in candidats if m['prof']['ens'].id not in pris), candidats[0]['prof'])
        pris.add(choix['ens'].id)
        db.session.add(TitulaireClasse(classe_id=info['classe'].id, enseignant_id=choix['ens'].id,
                                       annee_scolaire_id=annee.id))
        choix.setdefault('titulaire', []).append(info['classe'].option)
        info['titulaire'] = choix
    db.session.flush()


def creer_personnel(etab, classes):
    def compte(roles, detail=''):
        sexe, prenom, nom = personne()
        email = email_unique(prenom, nom)
        u, c = creer_compte(etab, prenom, nom, email, roles, sexe)
        c['detail'] = detail
        return u, c, (sexe, prenom, nom, email)

    comptable, _, _ = compte(['Comptable'], 'Économat')
    compte(['Secretaire'], 'Secrétariat')
    for cycle_lib in ('Premier Cycle', 'Second Cycle'):
        cl = [i['classe'] for i in classes if i['cycle'] == cycle_lib]
        u, c, (sexe, prenom, nom, email) = compte(['Censeur'], f"Censeur du {cycle_lib.lower()} "
                                                               f"({', '.join(x.option for x in cl)})")
        cen = Censeur(etablissement_id=etab.id, nom=nom, prenom=prenom, telephone=telephone(), email=email,
                      sexe=sexe, utilisateur_id=u.id)
        db.session.add(cen)
        db.session.flush()
        for x in cl:
            db.session.add(CenseurClasse(censeur_id=cen.id, classe_id=x.id))
        u, c, (sexe, prenom, nom, email) = compte(['Surveillant'], f"Surveillant général du {cycle_lib.lower()}")
        sg = Surveillant(etablissement_id=etab.id, nom=nom, prenom=prenom, telephone=telephone(), email=email,
                         sexe=sexe, utilisateur_id=u.id)
        db.session.add(sg)
        db.session.flush()
        for x in cl:
            db.session.add(SurveillantClasse(surveillant_id=sg.id, classe_id=x.id))
    db.session.flush()
    return comptable


# ── Emploi du temps ──────────────────────────────────────────────────────

def seances(h):
    return {1: [1], 2: [2], 3: [2, 1], 4: [2, 2], 5: [2, 2, 1], 6: [2, 2, 2]}[h]


def placer_classe(info, prof_occupe, rng):
    """Backtracking : place toutes les séances de la classe (une séance d'une
    matière par jour au plus). Renvoie [(mc, jour, heure)] ou None."""
    items = []
    for m in info['mcs']:
        for i, duree in enumerate(seances(m['heures'])):
            items.append((m, duree, i))
    items.sort(key=lambda it: (-it[1], -it[0]['prof']['heures'], rng.random()))
    classe_occupee = set()
    jours_matiere = {}
    resultat = []
    essais = [0]

    def candidats(m, duree):
        out = []
        for jour, nb in JOURS.items():
            if jour in jours_matiere.get(m['mc'].id, ()):
                continue
            debuts = [d for d in DEBUTS_BLOC if d + 1 < nb] if duree == 2 else range(nb)
            for d in debuts:
                heures = [d] if duree == 1 else [d, d + 1]
                if any((jour, h) in classe_occupee or (m['prof']['ens'].id, jour, h) in prof_occupe for h in heures):
                    continue
                # Préférence : matinée, EPS l'après-midi, un peu de hasard.
                score = d + rng.random() * 3
                if m['lib'] == 'EPS':
                    score = -d + rng.random() * 3
                out.append((score, jour, heures))
        out.sort()
        return out

    def dfs(k):
        essais[0] += 1
        if essais[0] > 20000:
            return False
        if k == len(items):
            return True
        m, duree, _ = items[k]
        for _, jour, heures in candidats(m, duree):
            for h in heures:
                classe_occupee.add((jour, h))
                prof_occupe.add((m['prof']['ens'].id, jour, h))
                resultat.append((m, jour, h))
            jours_matiere.setdefault(m['mc'].id, set()).add(jour)
            if dfs(k + 1):
                return True
            jours_matiere[m['mc'].id].discard(jour)
            for h in heures:
                classe_occupee.discard((jour, h))
                prof_occupe.discard((m['prof']['ens'].id, jour, h))
                resultat.pop()
        return False

    return resultat if dfs(0) else None


def creer_emploi_du_temps(etab, classes, annee):
    creneaux = []
    for lib, debut, fin in CRENEAUX:
        c = CreneauHoraire(etablissement_id=etab.id, libelle=lib, heure_debut=debut, heure_fin=fin)
        db.session.add(c)
        creneaux.append(c)
    db.session.flush()

    for tentative in range(300):
        rng = random.Random(1000 + tentative)
        prof_occupe = set()
        plan = {}
        ordre = sorted(classes, key=lambda i: -sum(m['heures'] for m in i['mcs']))
        for info in ordre:
            r = placer_classe(info, prof_occupe, rng)
            if r is None:
                break
            plan[info['classe'].id] = r
        else:
            break
    else:
        raise RuntimeError("Emploi du temps impossible à construire")

    salles = {}
    for i, info in enumerate(classes):
        salles[info['classe'].id] = f"Salle {i + 1:02d}"
    for info in classes:
        for m, jour, h in plan[info['classe'].id]:
            salle = 'Terrain' if m['lib'] == 'EPS' else ('Salle informatique' if m['lib'] == 'Informatique'
                                                          else salles[info['classe'].id])
            db.session.add(Horaire(matiere_classe_id=m['mc'].id, annee_scolaire_id=annee.id, jour_semaine=jour,
                                   creneau_id=creneaux[h].id, salle=salle))
    db.session.flush()
    return tentative + 1


# ── Élèves ───────────────────────────────────────────────────────────────

def creer_eleves(etab, classes, annee):
    parents, numero = [], 1
    for info in classes:
        classe = info['classe']
        info['inscriptions'] = []
        for _ in range(random.randint(50, 56)):
            if parents and random.random() < 0.18:  # fratries
                parent = random.choice(parents)
                nom = parent.nom
            else:
                sexe_p = random.choice('MF')
                _, prenom_p, nom = personne(sexe_p, unique=False)
                parent = Parent(etablissement_id=etab.id, nom=nom, prenom=prenom_p, telephone=telephone(),
                                email=email_unique(prenom_p, nom, f"parents.{DOMAINE}"))
                db.session.add(parent)
                db.session.flush()
                parents.append(parent)
            sexe = random.choice('MF')
            prenoms = random.sample(PRENOMS_M if sexe == 'M' else PRENOMS_F, random.choice([1, 1, 2]))
            # Quelques redoublants / élèves en retard d'un an.
            age = info['age'] + (1 if random.random() < 0.2 else 0)
            naissance = date(2026 - age, random.randint(1, 12), random.randint(1, 28))
            eleve = Eleve(etablissement_id=etab.id, matricule=f"LAU26{numero:04d}", nom=nom,
                          prenom=' '.join(prenoms), sexe=sexe, date_naissance=naissance,
                          lieu_naissance=random.choice(LIEUX), parent_id=parent.id, statut='Actif')
            numero += 1
            db.session.add(eleve)
            db.session.flush()
            jour = date(2026, 8, 3) + timedelta(days=random.randint(0, 40))
            insc = Inscription(eleve_id=eleve.id, classe_id=classe.id, annee_scolaire_id=annee.id,
                               date_inscription=jour, statut='Actif')
            db.session.add(insc)
            info['inscriptions'].append(insc)
        db.session.flush()
    return len(parents)


# ── Notes (CC + DS) ──────────────────────────────────────────────────────

def creer_notes(classes, sequences):
    """Séquences 1 et 2 : CC et DS pour tous, sauf 3 élèves par classe qui
    n'ont aucune note dans 3 matières (sur les deux séquences)."""
    seq_notees = sequences[:2]
    total, trous = 0, []
    for info in classes:
        niveau = {i.id: random.gauss(11.2, 2.9) for i in info['inscriptions']}
        manquants = {}
        for insc in random.sample(info['inscriptions'], 3):
            libs = random.sample([m['lib'] for m in info['mcs']], 3)
            manquants[insc.id] = set(libs)
            trous.append((info['classe'].option, insc.eleve, libs))
        for m in info['mcs']:
            difficulte = random.uniform(-1.8, 1.2)
            for seq in seq_notees:
                # Dates de l'évaluation : CC à mi-séquence, DS en fin de séquence.
                d_cc = seq.date_debut + timedelta(days=random.randint(12, 20))
                d_ds = min(seq.date_fin, date(2026, 11, 16)) - timedelta(days=random.randint(0, 5))
                # Saisie avant le verrouillage de la séquence (et pas dans le futur).
                limite = datetime.combine(min(seq.date_fin, date(2026, 11, 16)), time(20))
                for insc in info['inscriptions']:
                    if m['lib'] in manquants.get(insc.id, ()):
                        continue
                    for comp, ecart, jour in (('cc', 0.8, d_cc), ('ds', -0.3, d_ds)):
                        absent = random.random() < 0.012
                        valeur = None if absent else note_quart(niveau[insc.id] + difficulte + ecart
                                                                + random.gauss(0, 2.4))
                        db.session.add(Note(inscription_id=insc.id, matiere_classe_id=m['mc'].id,
                                            sequence_id=seq.id, composante=comp, valeur=valeur, absent=absent,
                                            saisie_le=min(limite, moment(jour + timedelta(days=random.randint(1, 4)),
                                                                         15, 22))))
                        total += 1
        db.session.flush()
    return total, trous


OBSERVATIONS = [None] * 6 + ['Bon comportement', 'Bavardages en classe', 'Élève assidu et appliqué',
                             "Doit fournir plus d'efforts", 'Retards répétés', 'Très bon élément',
                             'Travail irrégulier', 'Tenue non conforme']


def creer_discipline(classes, sequences):
    for seq in sequences[:2]:
        for info in classes:
            for insc in info['inscriptions']:
                db.session.add(Discipline(
                    inscription_id=insc.id, sequence_id=seq.id,
                    absences_justifiees=random.choice([0] * 6 + [1, 2, 2, 4]),
                    absences_non_justifiees=random.choice([0] * 8 + [1, 2, 3, 6]),
                    retards=random.choice([0] * 5 + [1, 1, 2, 3]),
                    exclusions=1 if random.random() < 0.02 else 0,
                    observation=random.choice(OBSERVATIONS)))
        db.session.flush()


# ── Paiements ────────────────────────────────────────────────────────────

_recu = [0]


def numero_recu(jour):
    _recu[0] += 1
    return f"LAU-{jour:%y%m%d}-{_recu[0]:05d}"


def mode_paiement():
    mode = random.choices(['ESPECES', 'MOBILE_MONEY', 'VIREMENT', 'CHEQUE'], weights=[45, 40, 8, 7])[0]
    ref = None
    if mode == 'MOBILE_MONEY':
        ref = random.choice(['OM', 'MP']) + f"{random.randint(10**9, 10**10 - 1)}"
    elif mode == 'VIREMENT':
        ref = f"VIR{random.randint(10**7, 10**8 - 1)}"
    elif mode == 'CHEQUE':
        ref = f"CHQ{random.randint(10**6, 10**7 - 1)}"
    return mode, ref


def creer_paiements(classes, annee, comptable):
    nb, annules, encaisse = 0, 0, Decimal(0)
    for info in classes:
        tranches = []
        for (lib, ordre, limite), montant in zip(ECHEANCIER, TARIFS[info['cycle']]):
            t = TrancheClasse(classe_id=info['classe'].id, annee_scolaire_id=annee.id, libelle=lib, ordre=ordre,
                              montant_attendu=Decimal(montant), date_limite=limite)
            db.session.add(t)
            tranches.append(t)
        db.session.flush()
        ins, t1, t2 = tranches[0], tranches[1], tranches[2]
        for insc in info['inscriptions']:
            versements = []  # (date, [(tranche, montant)])
            d0 = insc.date_inscription
            profil = random.random()
            if profil < 0.25:
                # Inscription + 1ère tranche le même jour.
                versements.append((d0, [(ins, ins.montant_attendu), (t1, t1.montant_attendu)]))
            else:
                versements.append((d0, [(ins, ins.montant_attendu)]))
                if profil < 0.62:
                    versements.append((date(2026, 9, 20) + timedelta(days=random.randint(0, 30)),
                                       [(t1, t1.montant_attendu)]))
                elif profil < 0.85:
                    # 1ère tranche en plusieurs fois, parfois pas encore soldée.
                    reste = t1.montant_attendu
                    jour = date(2026, 9, 25)
                    for _ in range(random.randint(1, 3)):
                        part = Decimal(random.choice([10000, 15000, 20000, 25000, 30000]))
                        part = min(part, reste)
                        jour = jour + timedelta(days=random.randint(5, 18))
                        if part <= 0 or jour > MAINTENANT.date():
                            break
                        versements.append((jour, [(t1, part)]))
                        reste -= part
                # sinon : rien après l'inscription (1ère tranche impayée, en retard)
            if profil < 0.12:
                # Familles qui avancent la 2ème tranche.
                montant = t2.montant_attendu if random.random() < 0.6 else Decimal(25000)
                versements.append((date(2026, 10, 20) + timedelta(days=random.randint(0, 25)), [(t2, montant)]))

            for jour, lignes in versements:
                jour = min(jour, MAINTENANT.date())
                if jour.weekday() == 6:
                    jour -= timedelta(days=1)
                mode, ref = mode_paiement()
                p = Paiement(inscription_id=insc.id, parent_id=insc.eleve.parent_id, encaisse_par_id=comptable.id,
                             numero_recu=numero_recu(jour), date_paiement=moment(jour, 7, 16),
                             montant_total=sum(mt for _, mt in lignes), mode_paiement=mode,
                             reference_transaction=ref, statut='VALIDE')
                db.session.add(p)
                db.session.flush()
                for tranche, mt in lignes:
                    db.session.add(LignePaiement(paiement_id=p.id, tranche_classe_id=tranche.id, montant_verse=mt))
                nb += 1
                encaisse += p.montant_total
                # Rare : reçu annulé (erreur de saisie) puis ressaisi.
                if random.random() < 0.006:
                    mode2, ref2 = mode_paiement()
                    faux = Paiement(inscription_id=insc.id, parent_id=insc.eleve.parent_id,
                                    encaisse_par_id=comptable.id, numero_recu=numero_recu(jour),
                                    date_paiement=moment(jour, 7, 16), montant_total=p.montant_total,
                                    mode_paiement=mode2, reference_transaction=ref2, statut='ANNULE',
                                    motif_annulation='Erreur de saisie : versement enregistré en double')
                    db.session.add(faux)
                    db.session.flush()
                    for tranche, mt in lignes:
                        db.session.add(LignePaiement(paiement_id=faux.id, tranche_classe_id=tranche.id,
                                                     montant_verse=mt))
                    annules += 1
        db.session.flush()
    return nb, annules, encaisse


# ── Fichier d'accès ──────────────────────────────────────────────────────

def ecrire_acces(etab, enseignants, admin_code):
    L = []
    L.append(f"{etab.nom} — ACCÈS À L'APPLICATION (année {ANNEE})")
    L.append(f"Code établissement : {etab.code}    Généré le {datetime.now():%d/%m/%Y à %H:%M}")
    L.append("Connexion : CODE + PIN. Chacun peut changer son PIN depuis son espace (« Changer mon code PIN »).")
    L.append("PIN oublié : l'Admin en régénère un depuis l'application.")
    L.append("")
    L.append("=" * 118)
    L.append("ENSEIGNANTS")
    L.append("=" * 118)
    L.append(f"{'CODE':<6}{'PIN':<8}{'NOM':<30}{'TÉLÉPHONE':<11}{'GRADE':<10}{'H/SEM':<6}COURS")
    L.append("-" * 118)
    for p in sorted(enseignants, key=lambda p: (p['departement'], p['compte']['nom'])):
        c = p['compte']
        cours = ', '.join(p['cours'])
        tit = f"  [Titulaire {', '.join(p['titulaire'])}]" if p.get('titulaire') else ''
        L.append(f"{c['code']:<6}{c['pin']:<8}{c['nom'][:29]:<30}{p['ens'].telephone:<11}{p['grade']:<10}"
                 f"{p['heures']:<6}{cours}{tit}")
    L.append("")
    L.append("=" * 118)
    L.append("PERSONNEL ADMINISTRATIF")
    L.append("=" * 118)
    L.append(f"{'CODE':<6}{'PIN':<8}{'RÔLE':<13}{'NOM':<30}DÉTAIL")
    L.append("-" * 118)
    L.append(f"{admin_code:<6}{'—':<8}{'Admin':<13}{'MR NYAKE':<30}Compte existant, PIN non modifié")
    for c in comptes:
        if c['role'] == 'Enseignant':
            continue
        L.append(f"{c['code']:<6}{c['pin']:<8}{c['role']:<13}{c['nom'][:29]:<30}{c['detail']}")
    contenu = '\n'.join(L) + '\n'
    for f in FICHIERS_ACCES:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(contenu, encoding='utf-8')


# ── Main ─────────────────────────────────────────────────────────────────

def main():
    with app.app_context():
        etab = Etablissement.query.filter_by(nom=NOM_ETAB).first()
        if not etab:
            sys.exit(f"Établissement « {NOM_ETAB} » introuvable.")
        if Classe.query.filter_by(etablissement_id=etab.id).first():
            sys.exit(f"{etab.nom} a déjà des classes : remplissage déjà fait. Abandon.")
        if etab.mode_evaluation != 'college':
            sys.exit(f"{etab.nom} n'est pas en mode Collège ({etab.mode_evaluation}). Abandon.")
        admin = Utilisateur.query.filter(Utilisateur.etablissement_id == etab.id,
                                         Utilisateur.roles.any(Role.libelle == 'Admin')).first()

        # Pas de journal d'audit pour le remplissage.
        event.remove(Session, 'after_flush', audit_services._apres_flush)

        Role.init_roles()
        initialiser_tresorerie(etab.id)
        for model in (Utilisateur, Enseignant, Parent, Censeur, Surveillant):
            _emails.update(e for (e,) in db.session.query(model.email) if e)

        try:
            annee, sequences, classes, matieres, departements, grades = creer_structure(etab)
            enseignants = creer_enseignants(etab, classes, matieres, departements, grades)
            creer_titulaires(classes, annee, enseignants)
            comptable = creer_personnel(etab, classes)
            tentatives = creer_emploi_du_temps(etab, classes, annee)
            nb_parents = creer_eleves(etab, classes, annee)
            nb_notes, trous = creer_notes(classes, sequences)
            creer_discipline(classes, sequences)
            nb_p, nb_annules, encaisse = creer_paiements(classes, annee, comptable)
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise

        ecrire_acces(etab, enseignants, admin.code_connexion if admin else '?')
        nb_eleves = sum(len(i['inscriptions']) for i in classes)
        print(f"{etab.nom} : {len(classes)} classes, {nb_eleves} élèves, {nb_parents} parents, "
              f"{len(enseignants)} enseignants, {len(comptes)} comptes")
        print(f"Emploi du temps construit en {tentatives} tentative(s)")
        print(f"{nb_notes} notes ; {nb_p} paiements valides ({encaisse:,.0f} FCFA), {nb_annules} annulés")
        print("Élèves sans note (séquences 1 et 2) :")
        for classe, eleve, libs in trous:
            print(f"  {classe:<8} {eleve.matricule} {eleve.nom} {eleve.prenom} : {', '.join(libs)}")
        print(f"Accès : {', '.join(map(str, FICHIERS_ACCES))}")


if __name__ == '__main__':
    main()
