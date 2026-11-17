from datetime import date

from sqlalchemy import event
from extensions import db
from models.authentification_models import CODE_LENGTH, generer_code_unique


# ---------------------------------------------------------------------------
# Modes d'évaluation, choisis par établissement ET par année scolaire :
#   - lycee    : une note par séquence (fonctionnement historique) ;
#   - college  : chaque séquence a un CC (30 %) et un DS (70 %) ;
#   - institut : chaque séquence a un CC, un DS et une évaluation
#                trimestrielle (Ev. Tr.), à parts égales.
# composantes : (code stocké dans Note.composante, libellé, poids). La note
# de la séquence vaut Σ(poids × note) / Σ poids ; une composante absente ou
# non saisie compte 0 (cf. mode_evaluation_services.notes_par_sequence).
# ---------------------------------------------------------------------------
MODE_EVALUATION_DEFAUT = 'lycee'
MODES_EVALUATION = {
    'lycee': {'libelle': 'Lycée', 'composantes': (('note', 'Note', 1),)},
    'college': {'libelle': 'Collège', 'composantes': (('cc', 'CC', 3), ('ds', 'DS', 7))},
    'institut': {'libelle': 'Institut', 'composantes': (('cc', 'CC', 1), ('ds', 'DS', 1), ('evtr', 'Ev. Tr.', 1))},
}

# ---------------------------------------------------------------------------
# Modèles de bulletin (gabarits static/templates/bulletins/), propres à un ou
# plusieurs modes d'évaluation. L'établissement choisit le sien parmi ceux de
# SON mode ; si l'année imprimée a un autre mode, le modèle par défaut de ce
# mode est utilisé (cf. mode_evaluation_services.modele_bulletin_effectif).
#   gabarit       : fichier Jinja ;
#   extremes      : colonne note min / note max de la classe ;
#   colonne_note  : après les évaluations d'une séquence, colonne « Note »
#                   (note de la séquence, ex. 30 % CC + 70 % DS en Collège).
# ---------------------------------------------------------------------------
MODELES_BULLETIN = {
    'original': {'libelle': 'Original', 'modes': ('lycee',), 'gabarit': 'bulletin.html'},
    'original_extremes': {'libelle': 'Original + rang et extrêmes', 'modes': ('lycee',),
                          'gabarit': 'bulletin.html', 'extremes': True},
    'bilingue_groupes': {'libelle': 'Bilingue, totaux par groupe', 'modes': ('lycee',),
                         'gabarit': 'bulletin_bilingue_groupes.html'},
    'professeurs_groupes': {'libelle': 'Professeurs et moyenne de classe', 'modes': ('lycee',),
                            'gabarit': 'bulletin_professeurs_groupes.html'},
    'original_college': {'libelle': 'Original', 'modes': ('college',),
                         'gabarit': 'bulletin_evaluations.html', 'colonne_note': True},
    'original_institut': {'libelle': 'Original', 'modes': ('institut',),
                          'gabarit': 'bulletin_evaluations.html'},
}
# Modèle par défaut de chaque mode (création d'établissement, repli).
MODELES_BULLETIN_DEFAUT = {'lycee': 'original', 'college': 'original_college', 'institut': 'original_institut'}
MODELE_BULLETIN_DEFAUT = MODELES_BULLETIN_DEFAUT[MODE_EVALUATION_DEFAUT]


class Etablissement(db.Model):
    __tablename__ = 'etablissement'

    id = db.Column(db.Integer, primary_key=True)
    # Code court de l'établissement (même alphabet que les codes de
    # connexion), attribué automatiquement à la création et jamais
    # modifiable : référence à communiquer au support. N'intervient PAS dans
    # la connexion (le code de connexion d'un Utilisateur suffit seul).
    code = db.Column(db.String(CODE_LENGTH), nullable=False)
    nom = db.Column(db.String(150), nullable=False)
    nom_bilingue = db.Column(db.String(150))
    adresse = db.Column(db.String(255))
    bp = db.Column(db.String(50))
    telephone = db.Column(db.String(20))
    region = db.Column(db.String(100))

    # Ne contient QUE le nom du fichier stocké sur disque (ex: "lycee-de-yaounde.png"),
    # jamais un chemin complet ni une URL externe. Le fichier réel vit dans
    # <racine_projet>/storage/logos/ (cf. services/structure_services.py).
    logo = db.Column(db.String(255))

    # Mode d'évaluation choisi à la création de l'établissement : sert de
    # valeur par défaut à chaque nouvelle année scolaire, qui porte ensuite
    # SON mode (AnneeScolaire.mode_evaluation, seul utilisé par les calculs).
    mode_evaluation = db.Column(db.String(10), nullable=False, default=MODE_EVALUATION_DEFAUT,
                                server_default=MODE_EVALUATION_DEFAUT)
    # Modèle de bulletin (cf. MODELES_BULLETIN), parmi ceux du mode d'évaluation.
    modele_bulletin = db.Column(db.String(30), nullable=False, default=MODELE_BULLETIN_DEFAUT,
                                server_default=MODELE_BULLETIN_DEFAUT)

    # Relations : un établissement possède son propre référentiel de cycles,
    # ses classes et ses années scolaires (isolation par etablissement_id)
    cycles = db.relationship('Cycle', backref='etablissement', lazy=True)
    classes = db.relationship('Classe', backref='etablissement', lazy=True)
    annees_scolaires = db.relationship('AnneeScolaire', backref='etablissement', lazy=True)

    __table_args__ = (
        db.UniqueConstraint('code', name='uq_etablissement_code'),
    )

    def to_dict(self):
        data = {k: getattr(self, k) for k in ['id', 'code', 'nom', 'nom_bilingue', 'adresse',
                'bp', 'telephone', 'region', 'logo', 'mode_evaluation', 'modele_bulletin']}
        # URL prête à l'emploi pour un <img src="..."> côté frontend, construite
        # à partir du nom de fichier stocké — jamais exposée telle quelle en base.
        data['logo_url'] = f"/api/etablissements/storage/logos/{self.logo}" if self.logo else None
        return data


@event.listens_for(Etablissement, 'before_insert')
def _attribuer_code_etablissement(mapper, connection, etablissement):
    if not etablissement.code:
        etablissement.code = generer_code_unique(connection, Etablissement.code)


class Cycle(db.Model):
    """Référentiel de cycles PROPRE à chaque établissement (ex: 1er cycle / 2nd cycle).
    Chaque établissement définit et gère ses propres cycles, contrairement
    à l'ancienne version où Cycle était un référentiel global partagé."""
    __tablename__ = 'cycle'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    libelle = db.Column(db.String(50), nullable=False)

    classes = db.relationship('Classe', backref='cycle', lazy=True)

    def to_dict(self):
        return {"id": self.id, "etablissement_id": self.etablissement_id,
                "libelle": self.libelle}


class Niveau(db.Model):
    """Niveau d'enseignement (6e, 5e, Tle, MACO 2…) regroupant les classes
    parallèles d'un établissement (6e A, 6e B…). Un élève qui change de
    classe AU SEIN DU MÊME NIVEAU garde ses notes et ses paiements (cf.
    changement_classe_services) ; le niveau sert aussi au statut redoublant
    du bulletin et aux conseils de classe par niveau."""
    __tablename__ = 'niveau'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    libelle = db.Column(db.String(50), nullable=False)
    ordre = db.Column(db.Integer, nullable=False, default=0, server_default='0')

    __table_args__ = (db.UniqueConstraint('etablissement_id', 'libelle', name='uq_niveau_etablissement'),)

    classes = db.relationship('Classe', backref='niveau', lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in ['id', 'etablissement_id', 'libelle', 'ordre']}


class Classe(db.Model):
    __tablename__ = 'classe'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    cycle_id = db.Column(db.Integer, db.ForeignKey('cycle.id'), nullable=False)
    option = db.Column(db.String(50))
    # Niveau (cf. Niveau) ; None : déduit du nom de la classe (cf.
    # bulletin_services.niveau_classe).
    niveau_id = db.Column(db.Integer, db.ForeignKey('niveau.id'), nullable=True)

    @property
    def effectif(self):
        """Élèves en cours (cf. STATUTS_INSCRIPTION_EN_COURS) inscrits dans
        la classe pour l'année ACTIVE de l'établissement — et non plus toutes
        années confondues."""
        return effectifs_classes(self.etablissement_id, [self.id]).get(self.id, 0)

    def to_dict(self, effectif=None):
        data = {k: getattr(self, k) for k in ['id', 'etablissement_id', 'cycle_id',
                'option', 'niveau_id']}
        data['effectif'] = self.effectif if effectif is None else effectif
        return data


class AnneeScolaire(db.Model):
    __tablename__ = 'annee_scolaire'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    libelle = db.Column(db.String(20), nullable=False)
    active = db.Column(db.Boolean, default=False)
    # Mode d'évaluation de l'année (cf. MODES_EVALUATION) : modifiable tant
    # qu'aucune note n'a été saisie dans l'année, définitif ensuite.
    mode_evaluation = db.Column(db.String(10), nullable=False, default=MODE_EVALUATION_DEFAUT,
                                server_default=MODE_EVALUATION_DEFAUT)

    __table_args__ = (db.UniqueConstraint('etablissement_id', 'libelle', name='uq_annee_scolaire_etablissement'),)

    trimestres = db.relationship('Trimestre', backref='annee_scolaire', lazy=True)

    @property
    def mode_verrouille(self):
        """Vrai dès qu'une note existe dans l'année : son mode est alors définitif."""
        if self.id is None:
            return False
        from models.evaluation_models import Note
        return db.session.query(
            Note.query
            .join(Sequence, Sequence.id == Note.sequence_id)
            .join(Trimestre, Trimestre.id == Sequence.trimestre_id)
            .filter(Trimestre.annee_scolaire_id == self.id)
            .exists()
        ).scalar()

    def to_dict(self):
        data = {k: getattr(self, k) for k in ['id', 'etablissement_id', 'libelle', 'active', 'mode_evaluation']}
        data['mode_verrouille'] = self.mode_verrouille
        return data


class Trimestre(db.Model):
    """Pas de etablissement_id direct : rattaché via annee_scolaire_id.
    L'isolation par établissement se fait par jointure sur AnneeScolaire."""
    __tablename__ = 'trimestre'

    id = db.Column(db.Integer, primary_key=True)
    annee_scolaire_id = db.Column(db.Integer, db.ForeignKey('annee_scolaire.id'), nullable=False)
    libelle = db.Column(db.String(20), nullable=False)
    date_debut = db.Column(db.Date)
    date_fin = db.Column(db.Date)

    sequences = db.relationship('Sequence', backref='trimestre', lazy=True)

    def to_dict(self):
        d = {k: getattr(self, k) for k in ['id', 'annee_scolaire_id', 'libelle']}
        if self.date_debut: d['date_debut'] = self.date_debut.isoformat()
        if self.date_fin: d['date_fin'] = self.date_fin.isoformat()
        return d


# État de la saisie des notes d'une séquence (cf. Sequence.verrou_depuis).
ETATS_SAISIE = ('auto', 'cloturee', 'ouverte')


class Sequence(db.Model):
    """Pas de etablissement_id direct : rattaché via trimestre_id -> annee_scolaire_id.

    Verrouillage de la saisie des notes (etat_saisie) :
      - 'auto'     : ouverte jusqu'à sa date de fin incluse, verrouillée ensuite ;
      - 'cloturee' : clôturée par l'administration (depuis cloturee_le) ;
      - 'ouverte'  : rouverte par l'administration, même après sa date de fin.
    Une séquence verrouillée n'est plus modifiable que par l'Admin et le
    SuperAdmin (cf. evaluation_services.refus_verrou)."""
    __tablename__ = 'sequence'

    id = db.Column(db.Integer, primary_key=True)
    trimestre_id = db.Column(db.Integer, db.ForeignKey('trimestre.id'), nullable=False)
    libelle = db.Column(db.String(10), nullable=False)
    date_debut = db.Column(db.Date)
    date_fin = db.Column(db.Date)
    etat_saisie = db.Column(db.String(10), nullable=False, default='auto', server_default='auto')
    cloturee_le = db.Column(db.DateTime, nullable=True)

    def verrou_depuis(self):
        """Moment (UTC naïf) à partir duquel la saisie est verrouillée, ou
        None si elle est ouverte."""
        from datetime import datetime, time, timedelta
        if self.etat_saisie == 'ouverte':
            return None
        if self.etat_saisie == 'cloturee':
            return self.cloturee_le or datetime.min
        if self.date_fin:
            return datetime.combine(self.date_fin + timedelta(days=1), time.min)
        return None

    def est_verrouillee(self, moment=None):
        from datetime import datetime
        depuis = self.verrou_depuis()
        return depuis is not None and (moment or datetime.utcnow()) >= depuis

    def to_dict(self):
        d = {k: getattr(self, k) for k in ['id', 'trimestre_id', 'libelle', 'etat_saisie']}
        if self.date_debut: d['date_debut'] = self.date_debut.isoformat()
        if self.date_fin: d['date_fin'] = self.date_fin.isoformat()
        d['verrouillee'] = self.est_verrouillee()
        return d

def annee_active(etablissement_id):
    """Année scolaire active de l'établissement ; à défaut la plus récente
    (libellé le plus grand, ex. '2025-2026'), ou None. Règle UNIQUE de
    l'application (espaces enseignant/censeur, effectifs, imports, vue
    réseau du SuperAdmin) : ne pas la redéfinir ailleurs."""
    annees = AnneeScolaire.query.filter_by(etablissement_id=etablissement_id).all()
    return next((a for a in annees if a.active), None) or max(annees, key=lambda a: a.libelle, default=None)


def cle_trimestre(trimestre):
    """Clé de tri CHRONOLOGIQUE d'un trimestre : sa date de début, à défaut
    celle de sa première séquence datée, à défaut l'ordre de création."""
    debut = trimestre.date_debut or min((s.date_debut for s in trimestre.sequences if s.date_debut), default=None)
    return (debut is None, debut or date.min, trimestre.id)


def cle_sequence(sequence):
    """Clé de tri CHRONOLOGIQUE d'une séquence (trimestre, puis date de
    début, puis ordre de création) : règle UNIQUE de l'application (bulletins,
    PV, espaces de saisie, séquence en cours)."""
    return (cle_trimestre(sequence.trimestre), sequence.date_debut is None,
            sequence.date_debut or date.min, sequence.id)


def trier_sequences(sequences):
    return sorted(sequences, key=cle_sequence)


def sequences_de_annee(annee_id):
    """Séquences d'une année scolaire, dans l'ordre chronologique."""
    return trier_sequences(
        Sequence.query
        .join(Trimestre, Trimestre.id == Sequence.trimestre_id)
        .filter(Trimestre.annee_scolaire_id == annee_id)
        .all()
    )


def sequence_courante(annee):
    """Séquence « en cours » de l'année (celle dont les dates encadrent
    aujourd'hui ; à défaut la dernière commencée ; à défaut la première), ou
    None si l'année n'a encore aucune séquence. Référence de l'avancement de
    la saisie des notes (espaces enseignant/censeur, vue réseau)."""
    if annee is None:
        return None
    sequences = sequences_de_annee(annee.id)
    if not sequences:
        return None
    aujourdhui = date.today()
    for sequence in sequences:
        if sequence.date_debut and sequence.date_fin and sequence.date_debut <= aujourdhui <= sequence.date_fin:
            return sequence
    commencees = [s for s in sequences if s.date_debut and s.date_debut <= aujourdhui]
    return commencees[-1] if commencees else sequences[0]


def effectifs_classes(etablissement_id, classe_ids=None, annee_scolaire_id=None):
    """{classe_id: effectif} en une seule requête : inscriptions en cours
    (STATUTS_INSCRIPTION_EN_COURS) de l'année donnée, ou de l'année active
    de l'établissement. Définition unique de l'effectif, partagée par les
    listes de classes, les espaces enseignant/censeur et les bulletins."""
    from models.inscription_models import Inscription, STATUTS_INSCRIPTION_EN_COURS

    if annee_scolaire_id is None:
        annee = annee_active(etablissement_id)
        if annee is None:
            return {}
        annee_scolaire_id = annee.id
    query = (
        db.session.query(Inscription.classe_id, db.func.count(Inscription.id))
        .join(Classe, Classe.id == Inscription.classe_id)
        .filter(Classe.etablissement_id == etablissement_id,
                Inscription.annee_scolaire_id == annee_scolaire_id,
                Inscription.statut.in_(STATUTS_INSCRIPTION_EN_COURS))
    )
    if classe_ids is not None:
        query = query.filter(Inscription.classe_id.in_(list(classe_ids)))
    return dict(query.group_by(Inscription.classe_id).all())
