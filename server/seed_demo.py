"""
Remplit la base avec des données de démonstration réalistes.

Usage :
    python seed_demo.py

- Complète l'établissement existant « LMA » (id=1) sans rien supprimer ni
  modifier de ce qui existe : on ajoute classes, matières, enseignants,
  personnel, parents, élèves, inscriptions, notes, discipline, emploi du
  temps, échéancier et paiements.
- Crée un second établissement de démo, « Collège Bilingue Les Pionniers »,
  rempli de la même façon (avec son propre compte Admin).

Chaque compte de connexion créé reçoit un code de connexion et un PIN
temporaire (même mécanisme que authentification_services.create_utilisateur :
valable 48h, changement obligatoire à la première connexion). Les codes et
PIN en clair sont écrits dans ~/Downloads/mots_de_passe_demo.txt et
mot_de_passe_demo.txt à la racine du projet — c'est la seule trace des PIN,
la base ne stocke que leurs hash bcrypt.

Le script refuse de tourner deux fois (il s'arrête si LMA a déjà des élèves
ou si l'établissement de démo existe).
"""

import random
import sys
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from app import create_app

app = create_app()

from extensions import db
from models.authentification_models import (
    Role, Utilisateur, generate_temp_pin, TEMP_PASSWORD_VALIDITY_HOURS,
)
from models.structure_models import Etablissement, Cycle, Classe, AnneeScolaire, Trimestre, Sequence
from models.pedagogie_models import (
    GroupeMatiere, Matiere, Departement, Grade, Enseignant, Censeur, Surveillant,
    TitulaireClasse, MatiereClasse, CenseurClasse, SurveillantClasse,
)
from models.inscription_models import Parent, Eleve, Inscription
from models.evaluation_models import Note, Discipline
from models.emploi_du_temps_models import CreneauHoraire, Horaire, JOURS_SEMAINE
from models.paiements_models import TrancheClasse, Paiement, LignePaiement

random.seed(2026)

# Copie dans Téléchargements + à la racine du projet (ignorée par git).
FICHIERS_MDP = [Path.home() / 'Downloads' / 'mots_de_passe_demo.txt',
                CURRENT_DIR.parent / 'mot_de_passe_demo.txt']
ANNEE = '2026-2027'
CHARGE_MAX_ENSEIGNANT = 20  # heures / semaine

# ── Référentiels de noms ─────────────────────────────────────────────────

NOMS = [
    'MBARGA', 'ATANGANA', 'NGUEMA', 'ESSOMBA', 'FOTSO', 'KAMGA', 'TCHOUPO', 'NJOYA',
    'BELLO', 'ABANDA', 'ONANA', 'EKOTTO', 'MVONDO', 'NANA', 'TAGNE', 'DJOMO', 'FOUDA',
    'MANGA', 'OWONA', 'EBOGO', 'NKOULOU', 'ZAMBO', 'BIYA', 'TCHAMENI', 'KENFACK',
    'WAMBA', 'NDJOCK', 'ETOUNDI', 'AMOUGOU', 'MOUSSA', 'HAMADOU', 'ALIOU', 'NGO BIYONG',
    'MESSI', 'ELLA', 'NDONGO', 'MEKA', 'SIMO', 'TAMO', 'FEUDJIO', 'NOUBISSI', 'DONGMO',
    'NGANOU', 'YOUMBI', 'KOUAM', 'POUOKAM', 'TCHINDA', 'MBIDA', 'NTOLO', 'ABEGA',
]
PRENOMS_M = [
    'Jean', 'Paul', 'Pierre', 'Samuel', 'Emmanuel', 'Joseph', 'Daniel', 'Christian',
    'Junior', 'Arnaud', 'Brice', 'Cédric', 'Franck', 'Hervé', 'Loïc', 'Yannick',
    'Steve', 'Boris', 'Ibrahim', 'Abdoulaye', 'Kevin', 'Willy', 'Rodrigue', 'Serge',
    'Thierry', 'Patrick', 'Ulrich', 'Landry', 'Fabrice', 'Achille', 'Blaise', 'Gaël',
]
PRENOMS_F = [
    'Marie', 'Grâce', 'Sandrine', 'Brigitte', 'Christelle', 'Larissa', 'Murielle',
    'Nadège', 'Rachel', 'Esther', 'Josiane', 'Carine', 'Aïcha', 'Fatimatou', 'Vanessa',
    'Laure', 'Joëlle', 'Ornella', 'Danielle', 'Prisca', 'Merveille', 'Sylvie', 'Edwige',
    'Pélagie', 'Clarisse', 'Diane', 'Inès', 'Mireille', 'Raïssa', 'Stéphanie',
]
VILLES = ['Yaoundé', 'Douala', 'Bafoussam', 'Garoua', 'Bamenda', 'Ebolowa', 'Bertoua', 'Kribi', 'Dschang', 'Ngaoundéré']

_emails_pris = set()


def sans_accents(s):
    import unicodedata
    s = unicodedata.normalize('NFD', s)
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn')


def email_unique(prenom, nom, domaine):
    base = sans_accents(f"{prenom}.{nom}").lower().replace(' ', '')
    email, n = f"{base}@{domaine}", 1
    while email in _emails_pris:
        n += 1
        email = f"{base}{n}@{domaine}"
    _emails_pris.add(email)
    return email


def telephone():
    return random.choice(['6', '6', '2']) + random.choice(['5', '7', '9', '8']) + ''.join(random.choice('0123456789') for _ in range(7))


def personne(sexe=None):
    sexe = sexe or random.choice('MF')
    return sexe, random.choice(PRENOMS_M if sexe == 'M' else PRENOMS_F), random.choice(NOMS)


# ── Comptes de connexion ─────────────────────────────────────────────────

comptes = []  # (établissement, rôles, nom, email, code de connexion, PIN)


def creer_compte(etab, nom, email, roles):
    pin = generate_temp_pin()
    u = Utilisateur(
        etablissement_id=etab.id, nom=nom, email=email, actif=True,
        roles=[Role.query.filter_by(libelle=r).one() for r in roles],
        doit_changer_mdp=True,
        mdp_expire_le=datetime.utcnow() + timedelta(hours=TEMP_PASSWORD_VALIDITY_HOURS),
    )
    u.set_password(pin)
    db.session.add(u)
    db.session.flush()  # attribue u.code_connexion (cf. Utilisateur before_insert)
    comptes.append((etab.nom, ', '.join(roles), nom, email, u.code_connexion, pin))
    return u


# ── Référentiels (get-or-create, pour réutiliser l'existant de LMA) ─────

def get_or_create(model, **kw):
    obj = model.query.filter_by(**kw).first()
    if not obj:
        obj = model(**kw)
        db.session.add(obj)
        db.session.flush()
    return obj


# libellé -> (groupe, département, coefficient, heures/semaine)
MATIERES = {
    'Maths': ('Matieres scientifiques', 'Mathematiques', 4, 5),
    'PCT': ('Matieres scientifiques', 'Physique Chimie et Technologie', 2, 3),
    'Physique': ('Matieres scientifiques', 'Physique Chimie et Technologie', 3, 4),
    'SVT': ('Matieres scientifiques', 'Sciences de la Vie et de la Terre', 2, 3),
    'Informatique': ('Matiere Complementaires', 'Informatique', 1, 2),
    'Redaction': ('Matieres Litteraires', 'Lettres et sciences Humaines', 3, 4),
    'Correction Orthographique': ('Matieres Litteraires', 'Lettres et sciences Humaines', 2, 2),
    'Anglais': ('Matieres Litteraires', 'Lettres et sciences Humaines', 2, 3),
    'Histoire-Geographie': ('Matieres Litteraires', 'Lettres et sciences Humaines', 2, 3),
    'Philosophie': ('Matieres Litteraires', 'Philosophie', 2, 3),
    'ECM': ('Matiere Complementaires', 'Lettres et sciences Humaines', 1, 1),
    'EPS': ('Matiere Complementaires', 'EPS', 1, 2),
}
PROGRAMME_CYCLE_1 = ['Maths', 'PCT', 'SVT', 'Redaction', 'Correction Orthographique', 'Anglais',
                     'Histoire-Geographie', 'ECM', 'Informatique', 'EPS']
PROGRAMME_SECONDE = ['Maths', 'Physique', 'SVT', 'Redaction', 'Anglais', 'Histoire-Geographie',
                     'Informatique', 'EPS']
PROGRAMME_TERMINALE = PROGRAMME_SECONDE + ['Philosophie']

CRENEAUX = [
    ('1ère heure', time(7, 30), time(8, 25)),
    ('2ème heure', time(8, 25), time(9, 20)),
    ('3ème heure', time(9, 20), time(10, 15)),
    ('4ème heure', time(10, 30), time(11, 25)),
    ('5ème heure', time(11, 25), time(12, 20)),
    ('6ème heure', time(13, 0), time(13, 55)),
    ('7ème heure', time(13, 55), time(14, 50)),
]

TRIMESTRES = [
    ('Trimestre 1', date(2026, 9, 5), date(2026, 12, 5), [
        ('Sequence 1', date(2026, 9, 5), date(2026, 10, 15)),
        ('Sequence 2', date(2026, 10, 16), date(2026, 12, 1)),
    ]),
    ('Trimestre 2', date(2027, 1, 4), date(2027, 3, 26), [
        ('Sequence 3', date(2027, 1, 4), date(2027, 2, 12)),
        ('Sequence 4', date(2027, 2, 15), date(2027, 3, 26)),
    ]),
    ('Trimestre 3', date(2027, 4, 5), date(2027, 6, 18), [
        ('Sequence 5', date(2027, 4, 5), date(2027, 5, 14)),
        ('Sequence 6', date(2027, 5, 17), date(2027, 6, 18)),
    ]),
]

ECHEANCIER = [
    ("Frais d'inscription", 1, date(2026, 9, 15)),
    ('1ère tranche', 2, date(2026, 10, 15)),
    ('2ème tranche', 3, date(2027, 1, 15)),
    ('3ème tranche', 4, date(2027, 3, 31)),
]


def assurer_annee(etab):
    annee = get_or_create(AnneeScolaire, etablissement_id=etab.id, libelle=ANNEE)
    annee.active = True
    sequences = []
    for lib, debut, fin, seqs in TRIMESTRES:
        tri = Trimestre.query.filter_by(annee_scolaire_id=annee.id, libelle=lib).first()
        if not tri:
            tri = Trimestre(annee_scolaire_id=annee.id, libelle=lib, date_debut=debut, date_fin=fin)
            db.session.add(tri)
            db.session.flush()
        for slib, sdebut, sfin in seqs:
            seq = Sequence.query.filter_by(trimestre_id=tri.id, libelle=slib).first()
            if not seq:
                seq = Sequence(trimestre_id=tri.id, libelle=slib, date_debut=sdebut, date_fin=sfin)
                db.session.add(seq)
                db.session.flush()
            sequences.append(seq)
    return annee, sequences


def assurer_classes(etab, structure):
    """structure : {libellé cycle: [(option, programme), ...]} -> [(classe, programme)]"""
    result = []
    for cycle_lib, classes in structure.items():
        cycle = Cycle.query.filter(Cycle.etablissement_id == etab.id, Cycle.libelle.ilike(cycle_lib)).first()
        if not cycle:
            cycle = Cycle(etablissement_id=etab.id, libelle=cycle_lib)
            db.session.add(cycle)
            db.session.flush()
        for option, programme in classes:
            classe = get_or_create(Classe, etablissement_id=etab.id, cycle_id=cycle.id, option=option)
            result.append((classe, programme))
    return result


def assurer_matiere(etab, libelle):
    groupe_lib, dep_lib, _, _ = MATIERES[libelle]
    groupe = get_or_create(GroupeMatiere, etablissement_id=etab.id, libelle=groupe_lib)
    matiere = Matiere.query.filter_by(etablissement_id=etab.id, libelle=libelle).first()
    if not matiere:
        matiere = Matiere(etablissement_id=etab.id, libelle=libelle, groupe_id=groupe.id)
        db.session.add(matiere)
        db.session.flush()
    get_or_create(Departement, etablissement_id=etab.id, libelle=dep_lib)
    return matiere


def creer_enseignant(etab, domaine, departement, grades):
    sexe, prenom, nom = personne()
    email = email_unique(prenom, nom, domaine)
    u = creer_compte(etab, f"{prenom} {nom}", email, ['Enseignant'])
    ens = Enseignant(
        etablissement_id=etab.id, nom=nom, prenom=prenom, telephone=telephone(), email=email,
        sexe=sexe, departement_id=departement.id, grade_id=random.choice(grades).id, utilisateur_id=u.id,
    )
    db.session.add(ens)
    db.session.flush()
    return ens


def heures(mc):
    return MATIERES.get(mc.matiere.libelle, (None, None, 1, 2))[3]


def affecter_matieres(etab, domaine, classes):
    """Crée les MatiereClasse manquantes, en répartissant la charge entre
    enseignants de la matière (création d'enseignants si nécessaire)."""
    grades = (Grade.query.filter_by(etablissement_id=etab.id).all()
              or [get_or_create(Grade, etablissement_id=etab.id, libelle=g) for g in ('PLEG', 'PCEG', 'VACATAIRE')])
    charge = {}
    for mc in MatiereClasse.query.join(Classe).filter(Classe.etablissement_id == etab.id).all():
        charge[mc.enseignant_id] = charge.get(mc.enseignant_id, 0) + heures(mc)

    for classe, programme in classes:
        for lib in programme:
            matiere = assurer_matiere(etab, lib)
            if MatiereClasse.query.filter_by(classe_id=classe.id, matiere_id=matiere.id).first():
                continue
            h = MATIERES[lib][3]
            departement = Departement.query.filter_by(etablissement_id=etab.id, libelle=MATIERES[lib][1]).one()
            # 1) un enseignant qui enseigne déjà cette matière ici, pas surchargé
            candidats = (Enseignant.query.join(MatiereClasse)
                         .filter(Enseignant.etablissement_id == etab.id, MatiereClasse.matiere_id == matiere.id)
                         .distinct().all())
            # 2) sinon un enseignant du bon département sans aucune affectation
            candidats += (Enseignant.query
                          .filter(Enseignant.etablissement_id == etab.id, Enseignant.departement_id == departement.id,
                                  ~Enseignant.matieres_classe.any()).all())
            ens = next((e for e in candidats if charge.get(e.id, 0) + h <= CHARGE_MAX_ENSEIGNANT), None)
            if not ens:
                ens = creer_enseignant(etab, domaine, departement, grades)
            mc = MatiereClasse(classe_id=classe.id, matiere_id=matiere.id, enseignant_id=ens.id,
                               coefficient=MATIERES[lib][2])
            db.session.add(mc)
            db.session.flush()
            charge[ens.id] = charge.get(ens.id, 0) + h


def creer_titulaires(classes, annee):
    for classe, _ in classes:
        if TitulaireClasse.query.filter_by(classe_id=classe.id, annee_scolaire_id=annee.id).first():
            continue
        deja = {t.enseignant_id for t in TitulaireClasse.query.filter_by(annee_scolaire_id=annee.id).all()}
        profs = [mc.enseignant_id for mc in classe.matieres_classe]
        libres = [p for p in profs if p not in deja] or profs
        db.session.add(TitulaireClasse(classe_id=classe.id, enseignant_id=random.choice(libres), annee_scolaire_id=annee.id))
    db.session.flush()


def creer_emploi_du_temps(etab, classes, annee):
    creneaux = []
    for lib, debut, fin in CRENEAUX:
        c = CreneauHoraire.query.filter_by(etablissement_id=etab.id, libelle=lib).first()
        if not c:
            c = CreneauHoraire(etablissement_id=etab.id, libelle=lib, heure_debut=debut, heure_fin=fin)
            db.session.add(c)
            db.session.flush()
        creneaux.append(c)

    jours = JOURS_SEMAINE[:5]
    prof_occupe, classe_occupee = set(), set()
    non_places = 0
    for i, (classe, _) in enumerate(classes):
        salle = f"Salle {i + 1:02d}"
        mcs = sorted(classe.matieres_classe, key=lambda m: -heures(m))
        for mc in mcs:
            restant = heures(mc)
            # Étale la matière sur des jours différents autant que possible.
            ordre_jours = random.sample(jours, len(jours))
            for passe in range(3):
                for jour in ordre_jours:
                    if restant == 0:
                        break
                    if passe == 0 and any(h for h in Horaire.query.filter_by(matiere_classe_id=mc.id, jour_semaine=jour)):
                        continue
                    for c in random.sample(creneaux, len(creneaux)):
                        if (classe.id, jour, c.id) in classe_occupee or (mc.enseignant_id, jour, c.id) in prof_occupe:
                            continue
                        db.session.add(Horaire(matiere_classe_id=mc.id, annee_scolaire_id=annee.id,
                                               jour_semaine=jour, creneau_id=c.id,
                                               salle='Terrain' if mc.matiere.libelle == 'EPS' else salle))
                        db.session.flush()
                        classe_occupee.add((classe.id, jour, c.id))
                        prof_occupe.add((mc.enseignant_id, jour, c.id))
                        restant -= 1
                        if passe < 2:
                            break
                if restant == 0:
                    break
            non_places += restant
    if non_places:
        print(f"   (emploi du temps : {non_places} heure(s) non placée(s) faute de créneau libre)")


def creer_personnel(etab, domaine, classes, admin=False):
    """Admin (si demandé), Proviseur, Comptable, Secrétaire, Censeurs, Surveillants."""
    def compte_simple(roles):
        sexe, prenom, nom = personne()
        return creer_compte(etab, f"{prenom} {nom}", email_unique(prenom, nom, domaine), roles)

    if admin:
        compte_simple(['Admin'])
    compte_simple(['Proviseur'])
    comptable = compte_simple(['Comptable'])
    compte_simple(['Secretaire'])

    # Censeurs : premier cycle / second cycle, chaque classe non encore assignée.
    cycles = {}
    for classe, _ in classes:
        cycles.setdefault(classe.cycle_id, []).append(classe)
    for cycle_id, cl in cycles.items():
        a_assigner = [c for c in cl if not CenseurClasse.query.filter_by(classe_id=c.id).first()]
        if not a_assigner:
            continue
        # Réutilise un censeur existant qui gère déjà une classe de ce cycle.
        existant = (Censeur.query.join(CenseurClasse).join(Classe)
                    .filter(Censeur.etablissement_id == etab.id, Classe.cycle_id == cycle_id).first())
        if not existant:
            sexe, prenom, nom = personne()
            email = email_unique(prenom, nom, domaine)
            u = creer_compte(etab, f"{prenom} {nom}", email, ['Censeur'])
            existant = Censeur(etablissement_id=etab.id, nom=nom, prenom=prenom, telephone=telephone(),
                               email=email, sexe=sexe, utilisateur_id=u.id)
            db.session.add(existant)
            db.session.flush()
        for c in a_assigner:
            db.session.add(CenseurClasse(censeur_id=existant.id, classe_id=c.id))

    # Deux surveillants, qui se partagent les classes.
    toutes = [c for c, _ in classes]
    moitie = (len(toutes) + 1) // 2
    for groupe in (toutes[:moitie], toutes[moitie:]):
        if not groupe:
            continue
        sexe, prenom, nom = personne()
        email = email_unique(prenom, nom, domaine)
        u = creer_compte(etab, f"{prenom} {nom}", email, ['Surveillant'])
        s = Surveillant(etablissement_id=etab.id, nom=nom, prenom=prenom, telephone=telephone(),
                        email=email, sexe=sexe, utilisateur_id=u.id)
        db.session.add(s)
        db.session.flush()
        for c in groupe:
            db.session.add(SurveillantClasse(surveillant_id=s.id, classe_id=c.id))
    db.session.flush()
    return comptable


def age_classe(classe):
    o = (classe.option or '').lower()
    for cle, age in (('6', 11), ('5', 12), ('4', 13), ('3', 14), ('seconde', 15), ('premiere', 16), ('terminale', 17)):
        if o.startswith(cle) or cle in o.split():
            return age
    return 13


def creer_eleves(etab, domaine, classes, annee, prefixe, effectif):
    """Parents + élèves + inscriptions. Renvoie {classe_id: [inscriptions]}."""
    parents = []
    inscriptions = {}
    numero = 1
    for classe, _ in classes:
        inscriptions[classe.id] = []
        for _ in range(random.randint(effectif - 4, effectif + 4)):
            # Fratries : un élève sur quatre partage un parent existant.
            if parents and random.random() < 0.25:
                parent = random.choice(parents)
                nom = parent.nom
            else:
                _, prenom_p, nom = personne()
                parent = Parent(etablissement_id=etab.id, nom=nom, prenom=prenom_p, telephone=telephone(),
                                email=email_unique(prenom_p, nom, f"parents.{domaine}"))
                db.session.add(parent)
                db.session.flush()
                parents.append(parent)
            sexe = random.choice('MF')
            prenoms = random.sample(PRENOMS_M if sexe == 'M' else PRENOMS_F, random.choice([1, 1, 2]))
            naissance = date(2026 - age_classe(classe), random.randint(1, 12), random.randint(1, 28))
            eleve = Eleve(etablissement_id=etab.id, matricule=f"{prefixe}26{numero:04d}", nom=nom,
                          prenom=' '.join(prenoms), sexe=sexe, date_naissance=naissance,
                          lieu_naissance=random.choice(VILLES), parent_id=parent.id, statut='Actif')
            numero += 1
            db.session.add(eleve)
            db.session.flush()
            insc = Inscription(eleve_id=eleve.id, classe_id=classe.id, annee_scolaire_id=annee.id,
                               date_inscription=date(2026, random.choice([8, 9]), random.randint(1, 28)),
                               statut='Actif')
            db.session.add(insc)
            db.session.flush()
            inscriptions[classe.id].append(insc)
    return inscriptions


def arrondi_quart(x):
    return Decimal(str(round(max(0.0, min(20.0, x)) * 4) / 4)).quantize(Decimal('0.01'))


def creer_notes(classes, inscriptions, sequences, enseignants_sans_seq2=()):
    """Séquence 1 : toutes les notes. Séquence 2 (en cours) : environ deux
    matières sur trois déjà saisies, le reste à saisir (sauf pour les
    enseignants listés, dont la séquence 2 reste vierge pour tester la saisie)."""
    seq1, seq2 = sequences[0], sequences[1]
    niveau = {}
    total = 0
    for classe, _ in classes:
        for insc in inscriptions[classe.id]:
            niveau[insc.id] = random.gauss(11.5, 2.8)
        for mc in classe.matieres_classe:
            difficulte = random.uniform(-1.5, 1.5)
            saisir_seq2 = mc.enseignant_id not in enseignants_sans_seq2 and random.random() < 0.65
            for seq in ([seq1, seq2] if saisir_seq2 else [seq1]):
                for insc in inscriptions[classe.id]:
                    absent = random.random() < 0.03
                    valeur = None if absent else arrondi_quart(niveau[insc.id] + difficulte + random.gauss(0, 2.5))
                    db.session.add(Note(inscription_id=insc.id, matiere_classe_id=mc.id, sequence_id=seq.id,
                                        valeur=valeur, absent=absent,
                                        saisie_le=datetime.combine(seq.date_fin or date.today(), time(10, 0))
                                        if seq is seq1 else datetime.utcnow() - timedelta(days=random.randint(0, 10))))
                    total += 1
        db.session.flush()
    return total


OBSERVATIONS = [None, None, None, 'Bon comportement', 'Bavardages fréquents', 'Élève assidu',
                'Doit fournir plus d\'efforts', 'Retards répétés', 'Très bon élément']


def creer_discipline(inscriptions, sequence):
    for liste in inscriptions.values():
        for insc in liste:
            db.session.add(Discipline(
                inscription_id=insc.id, sequence_id=sequence.id,
                absences_justifiees=random.choice([0, 0, 0, 1, 2, 4]),
                absences_non_justifiees=random.choice([0, 0, 0, 0, 1, 2, 3]),
                retards=random.choice([0, 0, 1, 1, 2, 3]),
                exclusions=1 if random.random() < 0.03 else 0,
                observation=random.choice(OBSERVATIONS),
            ))
    db.session.flush()


_recus = 0


def creer_paiements(classes, inscriptions, annee, comptable, tarifs):
    """tarifs : fonction(classe) -> [montant inscription, t1, t2, t3]."""
    global _recus
    for classe, _ in classes:
        tranches = []
        for (lib, ordre, limite), montant in zip(ECHEANCIER, tarifs(classe)):
            t = TrancheClasse(classe_id=classe.id, annee_scolaire_id=annee.id, libelle=lib, ordre=ordre,
                              montant_attendu=Decimal(montant), date_limite=limite)
            db.session.add(t)
            tranches.append(t)
        db.session.flush()

        for insc in inscriptions[classe.id]:
            parent_id = insc.eleve.parent_id
            profil = random.random()
            # Inscription toujours payée ; 1ère tranche : soldée, partielle ou impayée ;
            # quelques familles ont déjà avancé la 2ème tranche.
            versements = [[(tranches[0], tranches[0].montant_attendu)]]
            if profil < 0.6:
                versements.append([(tranches[1], tranches[1].montant_attendu)])
            elif profil < 0.85:
                versements.append([(tranches[1], (tranches[1].montant_attendu / 2).quantize(Decimal('1')))])
            if profil < 0.15:
                versements.append([(tranches[2], tranches[2].montant_attendu)])
            for k, lignes in enumerate(versements):
                _recus += 1
                mode = random.choice(['ESPECES', 'ESPECES', 'MOBILE_MONEY', 'MOBILE_MONEY', 'VIREMENT', 'CHEQUE'])
                jour = datetime.combine(insc.date_inscription, time(9)) + timedelta(days=k * 25 + random.randint(0, 10),
                                                                                    hours=random.randint(0, 7))
                p = Paiement(inscription_id=insc.id, parent_id=parent_id, encaisse_par_id=comptable.id,
                             numero_recu=f"REC-26-{_recus:06d}", date_paiement=min(jour, datetime.utcnow()),
                             montant_total=sum(m for _, m in lignes), mode_paiement=mode,
                             reference_transaction=f"TX{random.randint(10**8, 10**9 - 1)}" if mode in ('MOBILE_MONEY', 'VIREMENT') else None,
                             statut='VALIDE')
                db.session.add(p)
                db.session.flush()
                for tranche, montant in lignes:
                    db.session.add(LignePaiement(paiement_id=p.id, tranche_classe_id=tranche.id, montant_verse=montant))
        db.session.flush()


def tarifs_lma(classe):
    second = 'seconde' in classe.option.lower() or 'premiere' in classe.option.lower() or 'terminale' in classe.option.lower()
    return [15000, 45000, 35000, 30000] if second else [10000, 40000, 30000, 25000]


def tarifs_pionniers(classe):
    return [20000, 60000, 50000, 40000]


# ── Cumul de rôles ──────────────────────────────────────────────────────

def _sexe_de(prenom):
    return 'F' if prenom.split()[0] in PRENOMS_F else 'M'


def _compte_demo(etab, domaine, role, rang=0):
    comptes_role = (Utilisateur.query
                    .filter(Utilisateur.etablissement_id == etab.id, Utilisateur.email.like(f"%@{domaine}"),
                            Utilisateur.roles.any(Role.libelle == role))
                    .order_by(Utilisateur.id).all())
    return comptes_role[rang] if len(comptes_role) > rang else None


def _ajouter_role(u, role):
    r = Role.query.filter_by(libelle=role).one()
    if r not in u.roles:
        u.roles.append(r)


def _rendre_enseignant(u):
    """Ajoute le rôle Enseignant + un profil Enseignant, et lui confie une
    matière-classe prise à un collègue qui enseigne cette matière ailleurs
    (le nouvel enseignant n'a encore aucun cours : pas de collision
    d'emploi du temps possible)."""
    _ajouter_role(u, 'Enseignant')
    if Enseignant.query.filter_by(utilisateur_id=u.id).first():
        return
    prenom, nom = u.nom.rsplit(' ', 1) if ' ' in u.nom else (u.nom, u.nom)
    mcs = MatiereClasse.query.join(Classe).filter(Classe.etablissement_id == u.etablissement_id).all()
    par_prof = {}
    for mc in mcs:
        par_prof.setdefault(mc.enseignant_id, []).append(mc)
    candidats = [mc for liste in par_prof.values() if len(liste) >= 2 for mc in liste]
    mc = random.choice(candidats)
    departement = Departement.query.filter_by(etablissement_id=u.etablissement_id,
                                              libelle=MATIERES.get(mc.matiere.libelle, (None, 'Informatique'))[1]).first()
    ens = Enseignant(etablissement_id=u.etablissement_id, nom=nom, prenom=prenom, telephone=telephone(),
                     email=u.email, sexe=_sexe_de(prenom),
                     departement_id=(departement or mc.enseignant.departement).id,
                     grade_id=Grade.query.filter_by(etablissement_id=u.etablissement_id).first().id,
                     utilisateur_id=u.id)
    db.session.add(ens)
    db.session.flush()
    mc.enseignant_id = ens.id
    db.session.flush()


def _rendre_surveillant(u, nb_classes=2):
    _ajouter_role(u, 'Surveillant')
    if Surveillant.query.filter_by(utilisateur_id=u.id).first():
        return
    prenom, nom = u.nom.rsplit(' ', 1)
    s = Surveillant(etablissement_id=u.etablissement_id, nom=nom, prenom=prenom, telephone=telephone(),
                    email=u.email, sexe=_sexe_de(prenom), utilisateur_id=u.id)
    db.session.add(s)
    db.session.flush()
    classes = Classe.query.filter_by(etablissement_id=u.etablissement_id).order_by(Classe.id).all()
    for c in classes[-nb_classes:]:
        db.session.add(SurveillantClasse(surveillant_id=s.id, classe_id=c.id))
    db.session.flush()


def cumuler_roles():
    """Donne plusieurs rôles à quelques comptes de démo (choix d'espace à la
    connexion). Renvoie {email: 'Rôle1, Rôle2'}."""
    lma = Etablissement.query.get(1)
    pionniers = Etablissement.query.filter_by(nom='Collège Bilingue Les Pionniers').one()
    touches = []
    for etab, domaine, role, ajout in (
        (lma, 'lma.example.com', 'Censeur', 'Enseignant'),
        (lma, 'lma.example.com', 'Surveillant', 'Enseignant'),
        (lma, 'lma.example.com', 'Proviseur', 'Enseignant'),
        (lma, 'lma.example.com', 'Comptable', 'Secretaire'),
        (pionniers, 'pionniers.example.com', 'Admin', 'Enseignant'),
        (pionniers, 'pionniers.example.com', 'Censeur', 'Enseignant'),
        (pionniers, 'pionniers.example.com', 'Enseignant', 'Surveillant'),
    ):
        u = _compte_demo(etab, domaine, role)
        if not u:
            continue
        if ajout == 'Enseignant':
            _rendre_enseignant(u)
        elif ajout == 'Surveillant':
            _rendre_surveillant(u)
        else:
            _ajouter_role(u, ajout)
        touches.append(u)
    db.session.flush()
    return {u.email: ', '.join(u.libelles_roles()) for u in touches}


# ── Établissements ──────────────────────────────────────────────────────

def remplir(etab, domaine, structure, prefixe_matricule, effectif, tarifs, admin, enseignants_sans_seq2=()):
    print(f"→ {etab.nom}")
    annee, sequences = assurer_annee(etab)
    classes = assurer_classes(etab, structure)
    affecter_matieres(etab, domaine, classes)
    creer_titulaires(classes, annee)
    comptable = creer_personnel(etab, domaine, classes, admin=admin)
    creer_emploi_du_temps(etab, classes, annee)
    inscriptions = creer_eleves(etab, domaine, classes, annee, prefixe_matricule, effectif)
    nb_notes = creer_notes(classes, inscriptions, sequences, enseignants_sans_seq2)
    creer_discipline(inscriptions, sequences[0])
    creer_paiements(classes, inscriptions, annee, comptable, tarifs)
    nb_eleves = sum(len(v) for v in inscriptions.values())
    print(f"   {len(classes)} classes, {nb_eleves} élèves, {nb_notes} notes")


def main():
    with app.app_context():
        Role.init_roles()
        _emails_pris.update(e for (e,) in db.session.query(Utilisateur.email))
        _emails_pris.update(e for (e,) in db.session.query(Enseignant.email))
        _emails_pris.update(e for (e,) in db.session.query(Parent.email))

        lma = Etablissement.query.get(1)
        if not lma:
            sys.exit("Établissement id=1 introuvable.")
        if Eleve.query.filter_by(etablissement_id=lma.id).first():
            sys.exit(f"{lma.nom} a déjà des élèves : le remplissage a sans doute déjà été fait. Abandon.")
        if Etablissement.query.filter_by(nom='Collège Bilingue Les Pionniers').first():
            sys.exit("L'établissement de démo existe déjà. Abandon.")

        try:
            # Le compte NSOLLO (enseignant id=1) garde sa séquence 2 vierge
            # pour pouvoir tester la saisie de notes.
            remplir(
                lma, 'lma.example.com',
                {
                    'Premier Cycle': [('6 eme', PROGRAMME_CYCLE_1), ('5 eme', PROGRAMME_CYCLE_1),
                                      ('4 eme', PROGRAMME_CYCLE_1), ('3 eme', PROGRAMME_CYCLE_1)],
                    'Second cycle': [('Seconde A', PROGRAMME_SECONDE), ('Seconde C', PROGRAMME_SECONDE),
                                     ('Premiere C', PROGRAMME_TERMINALE), ('Terminale D', PROGRAMME_TERMINALE)],
                },
                'LMA', 25, tarifs_lma, admin=False, enseignants_sans_seq2={1},
            )

            pionniers = Etablissement(nom='Collège Bilingue Les Pionniers', nom_bilingue='The Pioneers Bilingual College',
                                      adresse='Rue des Écoles, Bonamoussadi, Douala', bp='BP 4521 Douala',
                                      telephone='233421987', region='Littoral')
            db.session.add(pionniers)
            db.session.flush()
            remplir(
                pionniers, 'pionniers.example.com',
                {
                    'Premier Cycle': [('6 eme', PROGRAMME_CYCLE_1), ('5 eme', PROGRAMME_CYCLE_1),
                                      ('4 eme', PROGRAMME_CYCLE_1), ('3 eme', PROGRAMME_CYCLE_1)],
                    'Second Cycle': [('Seconde C', PROGRAMME_SECONDE)],
                },
                'CBP', 18, tarifs_pionniers, admin=True,
            )
            cumuls = cumuler_roles()
            comptes[:] = [(e, cumuls.get(email, r), n, email, c, pin) for e, r, n, email, c, pin in comptes]
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise

        ecrire_fichier()
        print(f"\n✅ {len(comptes)} comptes créés. Codes et PIN : {', '.join(map(str, FICHIERS_MDP))}")


def ecrire_fichier(genere_le=None):
    genere_le = genere_le or datetime.now()
    expire = genere_le + timedelta(hours=TEMP_PASSWORD_VALIDITY_HOURS)
    lignes = [
        'CODES DE CONNEXION ET PIN TEMPORAIRES — DONNÉES DE DÉMONSTRATION',
        f"Généré le {genere_le:%d/%m/%Y à %H:%M}",
        f"PIN valables {TEMP_PASSWORD_VALIDITY_HOURS}h (jusqu'au {expire:%d/%m/%Y à %H:%M}) ; "
        "changement de PIN demandé à la première connexion.",
        "Passé ce délai : un Admin peut régénérer un PIN temporaire depuis l'application.",
        "Comptes à plusieurs rôles (marqués *) : après connexion, choisir l'espace de travail.",
        '',
    ]
    etab_courant = None
    largeur_roles = max(len(c[1]) + (2 if ',' in c[1] else 0) for c in comptes) + 2
    largeur = largeur_roles + 8 + 7 + 30
    for etab, roles, nom, _email, code, pin in comptes:
        if etab != etab_courant:
            etab_courant = etab
            lignes += ['', '=' * largeur, etab, '=' * largeur]
            lignes.append(f"{'RÔLE(S)':<{largeur_roles}}{'CODE':<8}{'PIN':<7}NOM")
            lignes.append('-' * largeur)
        marque = '* ' if ',' in roles else ''
        lignes.append(f"{marque + roles:<{largeur_roles}}{code:<8}{pin:<7}{nom}")
    contenu = '\n'.join(lignes) + '\n'
    for fichier in FICHIERS_MDP:
        fichier.parent.mkdir(parents=True, exist_ok=True)
        fichier.write_text(contenu, encoding='utf-8')


if __name__ == '__main__':
    main()
