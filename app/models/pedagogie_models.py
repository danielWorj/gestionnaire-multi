from extensions import db


# ---------------------------------------------------------------------------
# Référentiel global des matières (GroupeMatiere, Matiere)
#
# Contrairement à Cycle (cf. structure_models.py), ces deux modèles ne portent
# PAS de etablissement_id : c'est un référentiel partagé par tous les
# établissements (ex: "Mathématiques" appartient au groupe "Sciences", quel
# que soit l'établissement). Il est géré par le SuperAdmin, au même titre
# qu'Etablissement (cf. structure_api.make_admin_crud_blueprint, réutilisé
# tel quel pour ces deux modèles dans pedagogie_api.py).
# ---------------------------------------------------------------------------

class GroupeMatiere(db.Model):
    __tablename__ = 'groupe_matiere'

    id = db.Column(db.Integer, primary_key=True)
    libelle = db.Column(db.String(150), nullable=False)

    matieres = db.relationship('Matiere', backref='groupe', lazy=True)

    def to_dict(self):
        return {"id": self.id, "libelle": self.libelle}


class Matiere(db.Model):
    """Une matière appartient à un groupe (uq_matiere_groupe empêche deux
    matières de même libellé dans un même groupe). Pas de colonne
    'coefficient' ici : le coefficient d'une matière n'a de sens que dans le
    contexte d'une affectation classe/matière/enseignant précise — voir
    MatiereClasse.coefficient ci-dessous."""
    __tablename__ = 'matiere'

    id = db.Column(db.Integer, primary_key=True)
    libelle = db.Column(db.String(150), nullable=False)
    groupe_id = db.Column(db.Integer, db.ForeignKey('groupe_matiere.id'), nullable=False)

    __table_args__ = (
        db.UniqueConstraint('libelle', 'groupe_id', name='uq_matiere_groupe'),
    )

    matieres_classe = db.relationship('MatiereClasse', backref='matiere', lazy=True)

    def to_dict(self):
        return {"id": self.id, "libelle": self.libelle, "groupe_id": self.groupe_id}


# ---------------------------------------------------------------------------
# Enseignant — cloisonné par établissement (colonne etablissement_id directe,
# comme Utilisateur dans authentification_models.py). NB : Enseignant est un
# profil "métier" (identité + affectations pédagogiques), distinct du compte
# de connexion Utilisateur ; ce module ne gère aucun mot de passe/rôle JWT.
# ---------------------------------------------------------------------------

class Enseignant(db.Model):
    __tablename__ = 'enseignant'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    nom = db.Column(db.String(100), nullable=False)
    prenom = db.Column(db.String(100), nullable=False)
    telephone = db.Column(db.String(20))
    # Unique globalement (et non par établissement comme Utilisateur.email) :
    # un même enseignant, s'il intervient dans plusieurs établissements,
    # devrait à terme être identifié par un seul et même compte — cf. diagramme.
    email = db.Column(db.String(150), unique=True, nullable=False)
    grade = db.Column(db.String(50))

    etablissement = db.relationship('Etablissement', backref='enseignants', lazy=True)
    titulaires_classe = db.relationship('TitulaireClasse', backref='enseignant', lazy=True)
    matieres_classe = db.relationship('MatiereClasse', backref='enseignant', lazy=True)

    def to_dict(self):
        data = {k: getattr(self, k) for k in
                ['id', 'etablissement_id', 'nom', 'prenom', 'telephone', 'email', 'grade']}
        data['est_titulaire'] = self.est_titulaire
        return data

    @property
    def est_titulaire(self):
        """Calculé (pas de colonne stockée) : True si cet enseignant est
        titulaire d'au moins une classe, toutes années scolaires confondues.
        cf. note du diagramme : 'est_titulaire retiré : calcule via
        EXISTS(TitulaireClasse) WHERE enseignant_id=?'."""
        return db.session.query(
            TitulaireClasse.query.filter_by(enseignant_id=self.id).exists()
        ).scalar()


class TitulaireClasse(db.Model):
    """Affecte un enseignant comme titulaire d'une classe pour une année
    scolaire donnée. uq_titulaire_classe_annee garantit qu'une classe n'a
    jamais plus d'un titulaire pour une même année scolaire (un enseignant
    peut en revanche être titulaire de plusieurs classes en parallèle).

    Pas de etablissement_id direct : l'établissement propriétaire se déduit
    de classe_id -> Classe.etablissement_id (cf.
    pedagogie_services.get_etablissement_id_of), comme Trimestre/Sequence le
    font via annee_scolaire_id dans structure_models.py."""
    __tablename__ = 'titulaire_classe'

    id = db.Column(db.Integer, primary_key=True)
    classe_id = db.Column(db.Integer, db.ForeignKey('classe.id'), nullable=False)
    enseignant_id = db.Column(db.Integer, db.ForeignKey('enseignant.id'), nullable=False)
    annee_scolaire_id = db.Column(db.Integer, db.ForeignKey('annee_scolaire.id'), nullable=False)

    __table_args__ = (
        db.UniqueConstraint('classe_id', 'annee_scolaire_id', name='uq_titulaire_classe_annee'),
    )

    classe = db.relationship('Classe', backref='titulaires', lazy=True)
    annee_scolaire = db.relationship('AnneeScolaire', backref='titulaires_classe', lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ['id', 'classe_id', 'enseignant_id', 'annee_scolaire_id']}


class MatiereClasse(db.Model):
    """Affecte une matière à une classe, avec l'enseignant qui la dispense et
    le coefficient PROPRE à cette affectation (cf. docstring de Matiere : le
    coefficient n'existe qu'ici). uq_matiere_classe garantit qu'une classe n'a
    qu'une seule affectation par matière (donc un seul enseignant et un seul
    coefficient par couple classe/matière).

    Pas de etablissement_id direct : déduit de classe_id -> Classe.etablissement_id,
    comme pour TitulaireClasse."""
    __tablename__ = 'matiere_classe'

    id = db.Column(db.Integer, primary_key=True)
    classe_id = db.Column(db.Integer, db.ForeignKey('classe.id'), nullable=False)
    matiere_id = db.Column(db.Integer, db.ForeignKey('matiere.id'), nullable=False)
    enseignant_id = db.Column(db.Integer, db.ForeignKey('enseignant.id'), nullable=False)
    coefficient = db.Column(db.Integer, nullable=False)

    __table_args__ = (
        db.UniqueConstraint('classe_id', 'matiere_id', name='uq_matiere_classe'),
    )

    classe = db.relationship('Classe', backref='matieres_classe', lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ['id', 'classe_id', 'matiere_id', 'enseignant_id', 'coefficient']}