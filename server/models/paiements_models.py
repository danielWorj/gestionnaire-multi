from datetime import datetime
from extensions import db


# ---------------------------------------------------------------------------
# Refonte du module Paiements pour coller au diagramme de classe fourni.
#
# Changements par rapport à l'ancienne version (TranchePaiement / Paiement
# "plat") :
#
# 1. TranchePaiement -> TrancheClasse : l'échéancier n'est plus défini au
#    niveau de l'AnneeScolaire seule (un saut), mais au niveau du COUPLE
#    (classe_id, annee_scolaire_id) — deux classes de la même année peuvent
#    avoir des tranches et des montants différents. Nouveaux champs : ordre
#    (position dans l'échéancier) et date_limite (échéance).
#
# 2. Paiement devient un EN-TÊTE de versement (un enregistrement = un
#    versement = un reçu, numero_recu unique), plus une simple ligne
#    "inscription x tranche x montant". Il porte désormais qui paie
#    (parent_id) et qui encaisse (encaisse_par_id), un statut de cycle de
#    vie (VALIDE/ANNULE/REJETE/REMBOURSE) et les informations de traçabilité
#    (mode, référence de transaction, motif d'annulation).
#
# 3. LignePaiement (nouveau) : ventile un Paiement sur une ou plusieurs
#    TrancheClasse. Permet un règlement groupé (plusieurs tranches soldées
#    en un seul reçu) tout en gardant, par ligne, le détail tranche/montant.
#
# Cloisonnement par établissement (aucun des 3 modèles ne porte de colonne
# etablissement_id directe, cf. paiements_services.py) :
#   - TrancheClasse : UN saut -> classe_id -> Classe.etablissement_id
#     (annee_scolaire_id est également vérifié, cf. validation de cohérence
#     côté service, mais classe_id suffit pour la résolution directe).
#   - Paiement       : déduit de inscription_id -> Inscription.classe_id ->
#     Classe.etablissement_id.
#   - LignePaiement  : déduit de paiement_id -> Paiement (voir ci-dessus).
# ---------------------------------------------------------------------------


class TrancheClasse(db.Model):
    """Une échéance de l'échéancier de paiement d'une classe, pour une
    année scolaire donnée (ex : 1ère tranche, 2ème tranche, frais
    d'inscription...). uq_tranche_ordre et uq_tranche_libelle garantissent
    respectivement l'unicité de la position (ordre) et du libellé au sein
    d'un même (classe_id, annee_scolaire_id) : l'échéancier est complet et
    sans ambiguïté pour une classe et une année données.

    Une nouvelle rentrée scolaire ne fait PAS glisser automatiquement les
    tranches d'une année sur l'autre : elle nécessite une duplication
    explicite des lignes de l'échéancier de l'année précédente, avec
    montants et dates limites mis à jour (cf.
    paiements_services.dupliquer_echeancier_scoped)."""
    __tablename__ = 'tranche_classe'

    id = db.Column(db.Integer, primary_key=True)
    classe_id = db.Column(db.Integer, db.ForeignKey('classe.id'), nullable=False)
    annee_scolaire_id = db.Column(db.Integer, db.ForeignKey('annee_scolaire.id'), nullable=False)
    libelle = db.Column(db.String(100), nullable=False)
    ordre = db.Column(db.Integer, nullable=False)
    montant_attendu = db.Column(db.Numeric(10, 2), nullable=False)
    date_limite = db.Column(db.Date, nullable=True)

    __table_args__ = (
        db.UniqueConstraint('classe_id', 'annee_scolaire_id', 'ordre', name='uq_tranche_ordre'),
        db.UniqueConstraint('classe_id', 'annee_scolaire_id', 'libelle', name='uq_tranche_libelle'),
        db.CheckConstraint('ordre > 0', name='ck_tranche_ordre_positif'),
        db.CheckConstraint('montant_attendu > 0', name='ck_tranche_montant_positif'),
    )

    classe = db.relationship('Classe', backref='echeancier', lazy=True)
    annee_scolaire = db.relationship('AnneeScolaire', backref='echeancier', lazy=True)

    def to_dict(self):
        d = {k: getattr(self, k) for k in
             ['id', 'classe_id', 'annee_scolaire_id', 'libelle', 'ordre']}
        d['montant_attendu'] = float(self.montant_attendu) if self.montant_attendu is not None else None
        d['date_limite'] = self.date_limite.isoformat() if self.date_limite else None
        return d


class Paiement(db.Model):
    """En-tête d'un versement effectué par un Parent au titre d'une
    Inscription. Un enregistrement = un versement = un reçu : numero_recu
    est unique GLOBALEMENT (pas seulement par établissement), comme
    Parent.email dans inscription_models.py.

    Le statut porte ICI, sur l'en-tête, et non sur les lignes : une seule
    annulation (statut='ANNULE') neutralise l'ensemble des LignePaiement
    rattachées, plutôt que de devoir annuler chaque ligne individuellement.
    ck_paiement_annulation impose un motif dès que le statut passe à
    'ANNULE'.

    montant_total est ce que l'agent de caisse (encaisse_par_id) a
    effectivement reçu. L'égalité entre montant_total et la somme des
    LignePaiement.montant_verse rattachées est un CONTRÔLE applicatif
    (cf. paiements_services._validate_lignes_paiement), pas une contrainte
    de base : elle est vérifiée à la création, où l'en-tête et les lignes
    sont insérés dans une même transaction (cf.
    paiements_services.create_paiement_scoped)."""
    __tablename__ = 'paiement'

    id = db.Column(db.Integer, primary_key=True)
    inscription_id = db.Column(db.Integer, db.ForeignKey('inscription.id'), nullable=False)
    parent_id = db.Column(db.Integer, db.ForeignKey('parent.id'), nullable=False)
    encaisse_par_id = db.Column(db.Integer, db.ForeignKey('utilisateur.id'), nullable=False)
    numero_recu = db.Column(db.String(20), unique=True, nullable=False)
    date_paiement = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    montant_total = db.Column(db.Numeric(10, 2), nullable=False)
    mode_paiement = db.Column(db.String(30), nullable=False)
    reference_transaction = db.Column(db.String(50), nullable=True)
    statut = db.Column(db.String(15), nullable=False, default='VALIDE')
    motif_annulation = db.Column(db.String(255), nullable=True)

    __table_args__ = (
        db.CheckConstraint('montant_total > 0', name='ck_paiement_montant_positif'),
        db.CheckConstraint(
            "mode_paiement IN ('ESPECES','MOBILE_MONEY','VIREMENT','CHEQUE')",
            name='ck_paiement_mode'),
        db.CheckConstraint(
            "statut IN ('VALIDE','ANNULE','REJETE','REMBOURSE')",
            name='ck_paiement_statut'),
        db.CheckConstraint(
            "statut <> 'ANNULE' OR motif_annulation IS NOT NULL",
            name='ck_paiement_annulation'),
    )

    inscription = db.relationship('Inscription', backref='paiements', lazy=True)
    parent = db.relationship('Parent', backref='paiements_effectues', lazy=True)
    encaisse_par = db.relationship('Utilisateur', backref='paiements_encaisses', lazy=True)

    def to_dict(self, with_lignes=False):
        d = {k: getattr(self, k) for k in
             ['id', 'inscription_id', 'parent_id', 'encaisse_par_id', 'numero_recu',
              'mode_paiement', 'reference_transaction', 'statut', 'motif_annulation']}
        d['montant_total'] = float(self.montant_total) if self.montant_total is not None else None
        d['date_paiement'] = self.date_paiement.isoformat() if self.date_paiement else None
        if with_lignes:
            d['lignes'] = [l.to_dict() for l in self.lignes]
        return d


class LignePaiement(db.Model):
    """Ventilation d'un Paiement (versement) sur une TrancheClasse. Une
    seule ligne = paiement d'une seule tranche ; plusieurs lignes rattachées
    au même paiement_id = règlement groupé (plusieurs tranches soldées en un
    seul reçu). uq_ligne_paiement_tranche empêche deux lignes du même
    paiement sur la même tranche — une correction de montant se fait en
    modifiant la ligne existante (via annulation + nouveau paiement, cf.
    docstring de Paiement.statut), jamais par une ligne en double.

    Règles à contrôler côté service, PAS en base (cf.
    paiements_services._validate_lignes_paiement) :
      - SUM(montant_verse) des lignes d'un paiement == paiement.montant_total
      - tranche_classe.classe_id == inscription.classe_id ET
        tranche_classe.annee_scolaire_id == inscription.annee_scolaire_id,
        où inscription est celle du paiement parent
      - en-tête (Paiement) et lignes créés dans une même transaction

    Calculs dérivés (jamais stockés — cf. paiements_services.
    get_etat_paiements_inscription), sur les Paiement de statut VALIDE
    uniquement :
      paye(i, t)     = SUM(montant_verse) des lignes de l'inscription i sur
                        la tranche t
      reste_du(i, t) = t.montant_attendu - paye(i, t)
      solde(i)       = SUM(montant_attendu) de l'échéancier de i -
                        SUM(montant_total) des paiements VALIDE de i
      tranche en retard : aujourd'hui > t.date_limite ET reste_du(i, t) > 0

    Le solde n'est jamais stocké : il se désynchroniserait dès la première
    annulation de paiement."""
    __tablename__ = 'ligne_paiement'

    id = db.Column(db.Integer, primary_key=True)
    paiement_id = db.Column(db.Integer, db.ForeignKey('paiement.id'), nullable=False)
    tranche_classe_id = db.Column(db.Integer, db.ForeignKey('tranche_classe.id'), nullable=False)
    montant_verse = db.Column(db.Numeric(10, 2), nullable=False)

    __table_args__ = (
        db.UniqueConstraint('paiement_id', 'tranche_classe_id', name='uq_ligne_paiement_tranche'),
        db.CheckConstraint('montant_verse > 0', name='ck_ligne_montant_positif'),
    )

    paiement = db.relationship('Paiement', backref=db.backref('lignes', lazy=True))
    tranche_classe = db.relationship('TrancheClasse', backref='reglements', lazy=True)

    def to_dict(self):
        d = {k: getattr(self, k) for k in ['id', 'paiement_id', 'tranche_classe_id']}
        d['montant_verse'] = float(self.montant_verse) if self.montant_verse is not None else None
        return d