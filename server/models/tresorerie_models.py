from datetime import datetime
from extensions import db
from models.audit_models import Versionne


# ---------------------------------------------------------------------------
# Module Trésorerie : entrées et sorties d'argent de l'établissement, par
# catégorie, par compte (caisse, banque, mobile money) et par FONDS.
#
# Fonds affectés : chaque catégorie d'ENTRÉE est un fonds (Scolarité, APEE,
# Examens, Dons…). Une dépense (sortie) porte sa propre catégorie de SORTIE
# (Salaires, Fournitures…) ET indique, via VentilationDepense, sur quel(s)
# fonds elle est prise. Solde d'un fonds = entrées du fonds − dépenses
# imputées sur ce fonds.
#
# Les paiements de scolarité (paiements_models.Paiement) ne sont PAS recopiés
# ici : ils sont lus directement, chaque TrancheClasse étant rattachée à une
# catégorie d'entrée (categorie_entree_id, à défaut la catégorie par défaut
# de l'établissement), et chaque mode de paiement à un type de compte
# (cf. tresorerie_services.COMPTE_PAR_MODE). Seules les opérations hors
# scolarité sont saisies dans MouvementTresorerie.
#
# Traçabilité : assurée par le journal d'audit automatique (audit_services) ;
# un mouvement ne se supprime jamais, il s'annule (statut ANNULE + motif),
# comme un Paiement.
# ---------------------------------------------------------------------------

TYPES_CATEGORIE = ('ENTREE', 'SORTIE')
TYPES_COMPTE = ('CAISSE', 'BANQUE', 'MOBILE_MONEY')
SENS_MOUVEMENT = ('ENTREE', 'SORTIE', 'TRANSFERT')


class CategorieTresorerie(db.Model):
    """Catégorie d'entrée (= fonds) ou de sortie, propre à un établissement.
    par_defaut : la catégorie d'entrée qui reçoit les paiements de scolarité
    dont la tranche n'a pas de catégorie (une seule par établissement, créée
    automatiquement, ni supprimable ni désactivable)."""
    __tablename__ = 'categorie_tresorerie'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    type = db.Column(db.String(10), nullable=False)
    libelle = db.Column(db.String(100), nullable=False)
    par_defaut = db.Column(db.Boolean, nullable=False, default=False)
    actif = db.Column(db.Boolean, nullable=False, default=True)

    __table_args__ = (
        db.UniqueConstraint('etablissement_id', 'type', 'libelle', name='uq_categorie_tresorerie'),
        db.CheckConstraint("type IN ('ENTREE','SORTIE')", name='ck_categorie_tresorerie_type'),
    )

    def to_dict(self):
        return {k: getattr(self, k) for k in ['id', 'etablissement_id', 'type', 'libelle', 'par_defaut', 'actif']}


class CompteTresorerie(db.Model):
    """Là où se trouve l'argent : caisse (espèces), compte bancaire, compte
    mobile money. par_defaut : le compte de son type qui reçoit les paiements
    de scolarité (un par type et par établissement)."""
    __tablename__ = 'compte_tresorerie'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    type = db.Column(db.String(15), nullable=False)
    libelle = db.Column(db.String(100), nullable=False)
    par_defaut = db.Column(db.Boolean, nullable=False, default=False)
    actif = db.Column(db.Boolean, nullable=False, default=True)

    __table_args__ = (
        db.UniqueConstraint('etablissement_id', 'libelle', name='uq_compte_tresorerie'),
        db.CheckConstraint("type IN ('CAISSE','BANQUE','MOBILE_MONEY')", name='ck_compte_tresorerie_type'),
    )

    def to_dict(self):
        return {k: getattr(self, k) for k in ['id', 'etablissement_id', 'type', 'libelle', 'par_defaut', 'actif']}


class MouvementTresorerie(db.Model, Versionne):
    """Opération saisie à la main :
      - ENTREE    : argent reçu hors scolarité (don, subvention, report de
                    solde à l'ouverture…) — categorie_id = catégorie d'entrée ;
      - SORTIE    : dépense — categorie_id = catégorie de sortie, et une ou
                    plusieurs VentilationDepense sur les fonds (catégories
                    d'entrée) qui la financent, dont la somme == montant ;
      - TRANSFERT : argent déplacé d'un compte à un autre (dépôt des espèces
                    en banque…) — ni catégorie ni fonds, ne change que les
                    soldes des comptes.
    Contrôles de cohérence sens/catégorie/ventilation : côté service
    (tresorerie_services._valider_mouvement)."""
    __tablename__ = 'mouvement_tresorerie'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    sens = db.Column(db.String(10), nullable=False)
    date_operation = db.Column(db.Date, nullable=False)
    montant = db.Column(db.Numeric(12, 2), nullable=False)
    libelle = db.Column(db.String(255), nullable=False)
    categorie_id = db.Column(db.Integer, db.ForeignKey('categorie_tresorerie.id'), nullable=True)
    compte_id = db.Column(db.Integer, db.ForeignKey('compte_tresorerie.id'), nullable=False)
    compte_destination_id = db.Column(db.Integer, db.ForeignKey('compte_tresorerie.id'), nullable=True)
    tiers = db.Column(db.String(150), nullable=True)
    reference = db.Column(db.String(100), nullable=True)
    statut = db.Column(db.String(10), nullable=False, default='VALIDE')
    motif_annulation = db.Column(db.String(255), nullable=True)
    saisi_par_id = db.Column(db.Integer, db.ForeignKey('utilisateur.id'), nullable=False)
    cree_le = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    # Identifiant généré par l'appareil pour une opération saisie hors
    # connexion : un renvoi retrouve l'opération au lieu de la doubler.
    cle_idempotence = db.Column(db.String(40), nullable=True)

    __table_args__ = (
        db.UniqueConstraint('cle_idempotence', name='uq_mouvement_cle_idempotence'),
        db.CheckConstraint('montant > 0', name='ck_mouvement_montant_positif'),
        db.CheckConstraint("sens IN ('ENTREE','SORTIE','TRANSFERT')", name='ck_mouvement_sens'),
        db.CheckConstraint("statut IN ('VALIDE','ANNULE')", name='ck_mouvement_statut'),
        db.CheckConstraint("statut <> 'ANNULE' OR motif_annulation IS NOT NULL", name='ck_mouvement_annulation'),
        db.CheckConstraint(
            "(sens = 'TRANSFERT' AND categorie_id IS NULL AND compte_destination_id IS NOT NULL) OR "
            "(sens <> 'TRANSFERT' AND categorie_id IS NOT NULL AND compte_destination_id IS NULL)",
            name='ck_mouvement_coherence'),
        db.Index('ix_mouvement_etab_date', 'etablissement_id', 'date_operation'),
    )

    categorie = db.relationship('CategorieTresorerie', lazy=True)
    compte = db.relationship('CompteTresorerie', foreign_keys=[compte_id], lazy=True)
    compte_destination = db.relationship('CompteTresorerie', foreign_keys=[compte_destination_id], lazy=True)
    saisi_par = db.relationship('Utilisateur', lazy=True)

    def to_dict(self):
        d = {k: getattr(self, k) for k in
             ['id', 'etablissement_id', 'sens', 'libelle', 'categorie_id', 'compte_id',
              'compte_destination_id', 'tiers', 'reference', 'statut', 'motif_annulation',
              'saisi_par_id', 'version']}
        d['montant'] = float(self.montant) if self.montant is not None else None
        d['date_operation'] = self.date_operation.isoformat() if self.date_operation else None
        d['ventilation'] = [v.to_dict() for v in self.ventilations]
        return d


class VentilationDepense(db.Model):
    """Part d'une dépense (MouvementTresorerie de sens SORTIE) prise sur un
    fonds (catégorie d'ENTRÉE). Une dépense peut être répartie sur plusieurs
    fonds (ex. 60 % Scolarité, 40 % APEE) ; la somme des parts est égale au
    montant de la dépense (contrôle applicatif)."""
    __tablename__ = 'ventilation_depense'

    id = db.Column(db.Integer, primary_key=True)
    mouvement_id = db.Column(db.Integer, db.ForeignKey('mouvement_tresorerie.id'), nullable=False)
    categorie_entree_id = db.Column(db.Integer, db.ForeignKey('categorie_tresorerie.id'), nullable=False)
    montant = db.Column(db.Numeric(12, 2), nullable=False)

    __table_args__ = (
        db.UniqueConstraint('mouvement_id', 'categorie_entree_id', name='uq_ventilation_fonds'),
        db.CheckConstraint('montant > 0', name='ck_ventilation_montant_positif'),
    )

    mouvement = db.relationship('MouvementTresorerie', backref=db.backref('ventilations', lazy=True))

    def to_dict(self):
        return {
            'categorie_id': self.categorie_entree_id,
            'montant': float(self.montant) if self.montant is not None else None,
        }
