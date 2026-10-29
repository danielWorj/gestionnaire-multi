from extensions import db


# ---------------------------------------------------------------------------
# Parent, Eleve — cloisonnés par établissement (colonne etablissement_id
# directe), même logique que Enseignant/GroupeMatiere/Matiere dans
# pedagogie_models.py : chaque établissement gère son propre référentiel
# d'élèves et de parents, sans partage entre établissements.
#
# Inscription, elle, ne porte PAS de etablissement_id direct : son
# établissement propriétaire se déduit de classe_id -> Classe.etablissement_id
# (même logique que TitulaireClasse/MatiereClasse dans pedagogie_models.py,
# ou Horaire dans emploi_du_temps_models.py) — cf.
# inscription_services.get_etablissement_id_of.
# ---------------------------------------------------------------------------


class Parent(db.Model):
    """Représente le parent/tuteur d'un ou plusieurs élèves (cf. relation
    'enfants' ci-dessous). email est unique GLOBALEMENT (et non par
    établissement) : un même parent, s'il a des enfants dans plusieurs
    établissements, devrait à terme être identifié par une seule et même
    fiche — même choix de conception que Enseignant.email dans
    pedagogie_models.py."""
    __tablename__ = 'parent'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    nom = db.Column(db.String(100), nullable=False)
    prenom = db.Column(db.String(100), nullable=False)
    telephone = db.Column(db.String(20), nullable=False)
    email = db.Column(db.String(150), unique=True, nullable=False)

    etablissement = db.relationship('Etablissement', backref='parents', lazy=True)
    enfants = db.relationship('Eleve', backref='parent', lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ['id', 'etablissement_id', 'nom', 'prenom', 'telephone', 'email']}


class Eleve(db.Model):
    """uq_eleve_matricule_etablissement garantit l'unicité du matricule au
    sein d'un même établissement (deux établissements peuvent réutiliser le
    même matricule, ce sont deux élèves distincts).

    parent_id est une clé étrangère (donc nullable au niveau colonne, comme
    Censeur.utilisateur_id dans pedagogie_models.py), mais son caractère
    obligatoire est imposé explicitement via ck_eleve_parent plutôt que par
    nullable=False sur la colonne : un élève n'existe jamais sans parent
    rattaché, cf. diagramme."""
    __tablename__ = 'eleve'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    matricule = db.Column(db.String(50), nullable=False)
    nom = db.Column(db.String(100), nullable=False)
    prenom = db.Column(db.String(150), nullable=False)
    # 'M' (masculin) ou 'F' (féminin) — cf. ck_eleve_sexe ci-dessous, même
    # convention que Enseignant.sexe / Censeur.sexe / Surveillant.sexe.
    sexe = db.Column(db.String(1), nullable=False)
    date_naissance = db.Column(db.Date, nullable=True)
    lieu_naissance = db.Column(db.String(100), nullable=False)
    parent_id = db.Column(db.Integer, db.ForeignKey('parent.id'), nullable=True)
    statut = db.Column(db.String(10), nullable=False, default='Actif')

    __table_args__ = (
        db.UniqueConstraint('etablissement_id', 'matricule', name='uq_eleve_matricule_etablissement'),
        db.CheckConstraint("sexe IN ('M', 'F')", name='ck_eleve_sexe'),
        db.CheckConstraint("statut IN ('Actif', 'Inactif')", name='ck_eleve_statut'),
        db.CheckConstraint('parent_id IS NOT NULL', name='ck_eleve_parent'),
    )

    etablissement = db.relationship('Etablissement', backref='eleves', lazy=True)
    inscriptions = db.relationship('Inscription', backref='eleve', lazy=True)

    def to_dict(self):
        data = {k: getattr(self, k) for k in
                ['id', 'etablissement_id', 'matricule', 'nom', 'prenom', 'sexe',
                 'lieu_naissance', 'parent_id', 'statut']}
        data['date_naissance'] = self.date_naissance.isoformat() if self.date_naissance else None
        return data


class Inscription(db.Model):
    """Une case d'inscription : un Eleve inscrit dans une Classe pour une
    AnneeScolaire donnée. uq_inscription empêche la double inscription du
    même élève, dans la même classe, la même année scolaire (un élève
    redoublant/changeant de classe une année différente donne une nouvelle
    ligne, ce n'est pas bloqué).

    Pas de etablissement_id direct : déduit de classe_id ->
    Classe.etablissement_id — même logique que TitulaireClasse/MatiereClasse
    dans pedagogie_models.py (cf. inscription_services.get_etablissement_id_of).
    Utilisée par Classe.effectif dans structure_models.py (compte les
    Inscription.statut == 'Actif' de la classe)."""
    __tablename__ = 'inscription'

    id = db.Column(db.Integer, primary_key=True)
    eleve_id = db.Column(db.Integer, db.ForeignKey('eleve.id'), nullable=False)
    classe_id = db.Column(db.Integer, db.ForeignKey('classe.id'), nullable=False)
    annee_scolaire_id = db.Column(db.Integer, db.ForeignKey('annee_scolaire.id'), nullable=False)
    date_inscription = db.Column(db.Date, nullable=False)
    statut = db.Column(db.String(30), nullable=False, default='Actif')

    __table_args__ = (
        db.UniqueConstraint('eleve_id', 'classe_id', 'annee_scolaire_id', name='uq_inscription'),
    )

    classe = db.relationship('Classe', backref='inscriptions', lazy=True)
    annee_scolaire = db.relationship('AnneeScolaire', backref='inscriptions', lazy=True)

    def to_dict(self):
        d = {k: getattr(self, k) for k in
             ['id', 'eleve_id', 'classe_id', 'annee_scolaire_id', 'statut']}
        d['date_inscription'] = self.date_inscription.isoformat() if self.date_inscription else None
        return d