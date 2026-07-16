from extensions import db


class Etablissement(db.Model):
    __tablename__ = 'etablissement'

    id = db.Column(db.Integer, primary_key=True)
    nom = db.Column(db.String(150), nullable=False)
    nom_bilingue = db.Column(db.String(150))
    adresse = db.Column(db.String(255))
    bp = db.Column(db.String(50))
    telephone = db.Column(db.String(20))
    region = db.Column(db.String(100))
    logo_url = db.Column(db.String(255))

    # Relations : un établissement possède son propre référentiel de cycles,
    # ses classes et ses années scolaires (isolation par etablissement_id)
    cycles = db.relationship('Cycle', backref='etablissement', lazy=True)
    classes = db.relationship('Classe', backref='etablissement', lazy=True)
    annees_scolaires = db.relationship('AnneeScolaire', backref='etablissement', lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in ['id', 'nom', 'nom_bilingue', 'adresse',
                'bp', 'telephone', 'region', 'logo_url']}


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
    # ⚠️ 'effectif' n'est PAS une colonne : calculé via COUNT(Inscription)
    # WHERE classe_id=? AND statut='Actif' (cf. note du diagramme)

    @property
    def effectif(self):
        try:
            from models.inscription_models import Inscription
        except ModuleNotFoundError:
            return 0
        return (
            db.session.query(Inscription)
            .filter(Inscription.classe_id == self.id, Inscription.statut == 'Actif')
            .count()
    )
    def to_dict(self):
        data = {k: getattr(self, k) for k in ['id', 'etablissement_id', 'cycle_id',
                'option']}
        data['effectif'] = self.effectif
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