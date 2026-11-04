from sqlalchemy import event
from extensions import db
from models.authentification_models import CODE_LENGTH, generer_code_unique


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
                'bp', 'telephone', 'region', 'logo']}
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


class Classe(db.Model):
    __tablename__ = 'classe'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    cycle_id = db.Column(db.Integer, db.ForeignKey('cycle.id'), nullable=False)
    option = db.Column(db.String(50))

    @property
    def effectif(self):
        """Élèves en cours (cf. STATUTS_INSCRIPTION_EN_COURS) inscrits dans
        la classe pour l'année ACTIVE de l'établissement — et non plus toutes
        années confondues."""
        return effectifs_classes(self.etablissement_id, [self.id]).get(self.id, 0)

    def to_dict(self, effectif=None):
        data = {k: getattr(self, k) for k in ['id', 'etablissement_id', 'cycle_id',
                'option']}
        data['effectif'] = self.effectif if effectif is None else effectif
        return data


class AnneeScolaire(db.Model):
    __tablename__ = 'annee_scolaire'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    libelle = db.Column(db.String(20), nullable=False)
    active = db.Column(db.Boolean, default=False)

    __table_args__ = (db.UniqueConstraint('etablissement_id', 'libelle', name='uq_annee_scolaire_etablissement'),)

    trimestres = db.relationship('Trimestre', backref='annee_scolaire', lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in ['id', 'etablissement_id', 'libelle', 'active']}


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


class Sequence(db.Model):
    """Pas de etablissement_id direct : rattaché via trimestre_id -> annee_scolaire_id."""
    __tablename__ = 'sequence'

    id = db.Column(db.Integer, primary_key=True)
    trimestre_id = db.Column(db.Integer, db.ForeignKey('trimestre.id'), nullable=False)
    libelle = db.Column(db.String(10), nullable=False)
    date_debut = db.Column(db.Date)
    date_fin = db.Column(db.Date)

    def to_dict(self):
        d = {k: getattr(self, k) for k in ['id', 'trimestre_id', 'libelle']}
        if self.date_debut: d['date_debut'] = self.date_debut.isoformat()
        if self.date_fin: d['date_fin'] = self.date_fin.isoformat()
        return d

def annee_active(etablissement_id):
    """Année scolaire active de l'établissement ; à défaut la plus récente
    (libellé le plus grand, ex. '2025-2026'), ou None."""
    annees = AnneeScolaire.query.filter_by(etablissement_id=etablissement_id).all()
    return next((a for a in annees if a.active), None) or max(annees, key=lambda a: a.libelle, default=None)


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
