from extensions import db


# ---------------------------------------------------------------------------
# Matières (GroupeMatiere, Matiere) — cloisonnées par établissement
#
# Chaque établissement gère son propre référentiel de matières : deux
# établissements peuvent chacun avoir une matière "Mathématiques", ce sont
# deux lignes distinctes, non partagées. Cloisonnement DIRECT (colonne
# etablissement_id sur chacun des deux modèles), comme Enseignant plus bas —
# et non déduit indirectement via une autre table.
# ---------------------------------------------------------------------------

class GroupeMatiere(db.Model):
    __tablename__ = 'groupe_matiere'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    libelle = db.Column(db.String(150), nullable=False)

    __table_args__ = (
        # Deux groupes de même libellé sont possibles dans deux établissements
        # différents, mais pas deux fois dans le même établissement.
        db.UniqueConstraint('libelle', 'etablissement_id', name='uq_groupe_matiere_etablissement'),
    )

    etablissement = db.relationship('Etablissement', backref='groupes_matiere', lazy=True)
    matieres = db.relationship('Matiere', backref='groupe', lazy=True)

    def to_dict(self):
        return {"id": self.id, "etablissement_id": self.etablissement_id, "libelle": self.libelle}


class Matiere(db.Model):
    """Une matière appartient à un groupe (uq_matiere_groupe empêche deux
    matières de même libellé dans un même groupe) et, comme GroupeMatiere,
    porte directement son propre etablissement_id (et non pas seulement via
    groupe_id -> GroupeMatiere.etablissement_id : cf.
    pedagogie_services._validate_foreign_keys_scoped, qui vérifie que le
    groupe choisi appartient bien au même établissement que la matière).
    Pas de colonne 'coefficient' ici : le coefficient d'une matière n'a de
    sens que dans le contexte d'une affectation classe/matière/enseignant
    précise — voir MatiereClasse.coefficient ci-dessous."""
    __tablename__ = 'matiere'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    libelle = db.Column(db.String(150), nullable=False)
    groupe_id = db.Column(db.Integer, db.ForeignKey('groupe_matiere.id'), nullable=False)

    __table_args__ = (
        db.UniqueConstraint('libelle', 'groupe_id', name='uq_matiere_groupe'),
    )

    etablissement = db.relationship('Etablissement', backref='matieres', lazy=True)
    matieres_classe = db.relationship('MatiereClasse', backref='matiere', lazy=True)

    def to_dict(self):
        return {"id": self.id, "etablissement_id": self.etablissement_id,
                "libelle": self.libelle, "groupe_id": self.groupe_id}


# ---------------------------------------------------------------------------
# Departement, Grade — référentiels cloisonnés par établissement.
#
# Un Departement regroupe plusieurs Enseignant (1-N) ; un Enseignant
# appartient à un seul Departement. Même logique pour Grade. Cloisonnement
# DIRECT (colonne etablissement_id), comme GroupeMatiere/Matiere/Enseignant.
# ---------------------------------------------------------------------------

class Departement(db.Model):
    __tablename__ = 'departement'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    libelle = db.Column(db.String(150), nullable=False)

    __table_args__ = (
        db.UniqueConstraint('libelle', 'etablissement_id', name='uq_departement_etablissement'),
    )

    etablissement = db.relationship('Etablissement', backref='departements', lazy=True)
    enseignants = db.relationship('Enseignant', backref='departement', lazy=True)

    def to_dict(self):
        return {"id": self.id, "etablissement_id": self.etablissement_id, "libelle": self.libelle}


class Grade(db.Model):
    __tablename__ = 'grade'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    libelle = db.Column(db.String(150), nullable=False)

    __table_args__ = (
        db.UniqueConstraint('libelle', 'etablissement_id', name='uq_grade_etablissement'),
    )

    etablissement = db.relationship('Etablissement', backref='grades', lazy=True)
    enseignants = db.relationship('Enseignant', backref='grade', lazy=True)

    def to_dict(self):
        return {"id": self.id, "etablissement_id": self.etablissement_id, "libelle": self.libelle}


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
    # 'M' (masculin) ou 'F' (féminin) — cf. CheckConstraint ci-dessous.
    # Nullable pour ne pas casser les enregistrements existants créés avant
    # l'ajout de cet attribut ; le formulaire de création/édition côté
    # client (enseignant.html) l'exige néanmoins pour toute nouvelle saisie,
    # afin de fiabiliser les statistiques par sexe.
    sexe = db.Column(db.String(1), nullable=True)
    # Remplace l'ancienne colonne texte libre 'grade' : le grade est
    # désormais un référentiel cloisonné par établissement (cf. Grade
    # ci-dessus). Même logique pour departement_id -> Departement.
    departement_id = db.Column(db.Integer, db.ForeignKey('departement.id'), nullable=False)
    grade_id = db.Column(db.Integer, db.ForeignKey('grade.id'), nullable=False)
    # Lien vers le compte de connexion (Utilisateur, rôle 'Enseignant') —
    # AJOUTÉ pour le module Évaluation (cf. evaluation_service.py) : un
    # Enseignant ne peut saisir/lire ses Note QUE sur les MatiereClasse qui
    # lui ont été attribuées, ce qui suppose de savoir, à partir du JWT,
    # quel Enseignant est connecté. Même logique et même raisonnement que
    # Censeur.utilisateur_id / Surveillant.utilisateur_id ci-dessous : une
    # colonne explicite plutôt qu'une correspondance implicite par email
    # (non garantie), renseignée par l'Admin d'établissement une fois le
    # compte de connexion créé. Nullable : le profil peut exister avant
    # d'être relié. Résolu EN DIRECT à chaque requête (jamais depuis un
    # claim JWT mis en cache) via pedagogie_services.resolve_enseignant_profil,
    # pour la même raison que pour Censeur/Surveillant (cf. docstring de
    # resolve_classe_ids_restriction plus bas dans pedagogie_services.py).
    utilisateur_id = db.Column(db.Integer, db.ForeignKey('utilisateur.id'), unique=True, nullable=True)

    __table_args__ = (
        db.CheckConstraint("sexe IN ('M', 'F')", name='ck_enseignant_sexe'),
    )

    etablissement = db.relationship('Etablissement', backref='enseignants', lazy=True)
    titulaires_classe = db.relationship('TitulaireClasse', backref='enseignant', lazy=True)
    matieres_classe = db.relationship('MatiereClasse', backref='enseignant', lazy=True)
    utilisateur = db.relationship('Utilisateur', backref=db.backref('profil_enseignant', uselist=False), lazy=True)

    def to_dict(self):
        data = {k: getattr(self, k) for k in
                ['id', 'etablissement_id', 'nom', 'prenom', 'telephone', 'email', 'sexe',
                 'departement_id', 'grade_id', 'utilisateur_id']}
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


# ---------------------------------------------------------------------------
# Censeur, Surveillant — profils métier cloisonnés par établissement, même
# logique de cloisonnement direct qu'Enseignant (colonne etablissement_id),
# mais sans departement_id/grade_id (référentiels propres aux enseignants,
# non pertinents ici). Comme Enseignant, ces modèles restent TECHNIQUEMENT
# distincts du compte de connexion Utilisateur (authentification_models.py) :
# ils ne portent ni mot de passe ni role_id.
#
# Côté API, ils ne sont plus créés en deux temps séparés : POST
# /api/censeurs/creer-avec-compte (ou /api/surveillants/creer-avec-compte)
# crée le profil ET le compte de connexion (rôle 'Censeur'/'Surveillant')
# EN UNE SEULE opération, avec mot de passe temporaire généré et
# doit_changer_mdp=True — exactement le même mécanisme que pour tout autre
# Utilisateur (cf. authentification_services.create_utilisateur), pour que
# la personne soit forcée de changer son mot de passe à sa première
# connexion, comme un Admin ou un Enseignant. Voir
# pedagogie_services._creer_profil_avec_compte. Le POST /<name>/ générique
# (create_entity_scoped, sans compte) reste disponible pour un profil créé
# seul, à relier plus tard via 'utilisateur_id' — cf. ci-dessous.
# ---------------------------------------------------------------------------

class Censeur(db.Model):
    __tablename__ = 'censeur'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    nom = db.Column(db.String(100), nullable=False)
    prenom = db.Column(db.String(100), nullable=False)
    telephone = db.Column(db.String(20))
    # Unique globalement, comme Enseignant.email (cf. docstring Enseignant).
    email = db.Column(db.String(150), unique=True, nullable=False)
    sexe = db.Column(db.String(1), nullable=True)
    # Lien vers le compte de connexion (Utilisateur, authentification_models.py)
    # qui porte le rôle 'Censeur' pour cette personne. Le profil "métier"
    # (ce modèle) et le compte de connexion sont créés séparément (cf.
    # docstring de fichier ci-dessus) ; cette colonne, renseignée par l'Admin
    # d'établissement (PUT /api/censeurs/<id>), est ce qui permet de les
    # relier explicitement — plutôt qu'une correspondance implicite par email,
    # non garantie. Nullable : le profil peut exister avant d'être relié.
    # Unique : un même Utilisateur ne peut être lié qu'à un seul profil
    # Censeur. C'est CE lien qui permet de résoudre, à partir du JWT (claim
    # 'profil_id', cf. authentification_services._build_claims), quel Censeur
    # est connecté — nécessaire pour restreindre son accès aux classes qui
    # lui ont été assignées (cf. CenseurClasse ci-dessous).
    utilisateur_id = db.Column(db.Integer, db.ForeignKey('utilisateur.id'), unique=True, nullable=True)

    __table_args__ = (
        db.CheckConstraint("sexe IN ('M', 'F')", name='ck_censeur_sexe'),
    )

    etablissement = db.relationship('Etablissement', backref='censeurs', lazy=True)
    utilisateur = db.relationship('Utilisateur', backref=db.backref('profil_censeur', uselist=False), lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ['id', 'etablissement_id', 'nom', 'prenom', 'telephone', 'email', 'sexe', 'utilisateur_id']}


class Surveillant(db.Model):
    __tablename__ = 'surveillant'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    nom = db.Column(db.String(100), nullable=False)
    prenom = db.Column(db.String(100), nullable=False)
    telephone = db.Column(db.String(20))
    email = db.Column(db.String(150), unique=True, nullable=False)
    sexe = db.Column(db.String(1), nullable=True)
    # Voir Censeur.utilisateur_id ci-dessus : même logique de liaison au
    # compte de connexion (rôle 'Surveillant'), pour la même raison (résoudre
    # 'profil_id' dans le JWT et restreindre l'accès aux classes assignées,
    # cf. SurveillantClasse ci-dessous).
    utilisateur_id = db.Column(db.Integer, db.ForeignKey('utilisateur.id'), unique=True, nullable=True)

    __table_args__ = (
        db.CheckConstraint("sexe IN ('M', 'F')", name='ck_surveillant_sexe'),
    )

    etablissement = db.relationship('Etablissement', backref='surveillants', lazy=True)
    utilisateur = db.relationship('Utilisateur', backref=db.backref('profil_surveillant', uselist=False), lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ['id', 'etablissement_id', 'nom', 'prenom', 'telephone', 'email', 'sexe', 'utilisateur_id']}


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


# ---------------------------------------------------------------------------
# CenseurClasse, SurveillantClasse — classes dont un Censeur/Surveillant a la
# charge au sein de son établissement (assignation Censeur/Surveillant ↔
# Classe). Deux tables dédiées plutôt qu'une table polymorphe unique, pour
# rester dans l'esprit du reste du fichier qui traite déjà Censeur et
# Surveillant comme deux entités distinctes malgré leur ressemblance
# (blueprints séparés dans pedagogie_api.py, pas de classe de base commune).
#
# Pas de etablissement_id direct sur ces deux modèles : déduit de
# classe_id -> Classe.etablissement_id, même logique que TitulaireClasse/
# MatiereClasse ci-dessus (cf. pedagogie_services.INDIRECT_SCOPE_MODELS). La
# cohérence censeur.etablissement_id == classe.etablissement_id est vérifiée
# à la création/mise à jour côté service (_validate_foreign_keys_scoped).
#
# Gestion (création/modification/suppression, ET lecture) réservée à l'Admin
# d'établissement et au SuperAdmin — cf. censeur_classe_bp/surveillant_classe_bp
# dans pedagogie_api.py, roles_autorises=("Admin","SuperAdmin") sur tous les
# verbes : ni le Censeur ni le Surveillant ne peuvent s'auto-assigner une
# classe, ni même consulter la table d'assignation brute (ils découvrent leur
# périmètre via les endpoints déjà filtrés : /api/classes/, /api/matieres-classe/,
# /api/titulaires-classe/, /api/horaires/ — cf. resolve_classe_ids_restriction
# dans pedagogie_services.py).
# ---------------------------------------------------------------------------

class CenseurClasse(db.Model):
    """Une classe n'appartient qu'à un seul Censeur (contrairement à
    SurveillantClasse ci-dessous, où plusieurs Surveillants peuvent partager
    une même classe) : uq_censeur_classe_unique_classe porte sur classe_id
    SEUL (et non sur le couple censeur_id/classe_id) pour l'imposer au
    niveau base de données, en plus de la vérification explicite faite côté
    service (cf. pedagogie_services._validate_foreign_keys_scoped) qui
    renvoie un message d'erreur clair plutôt que de laisser remonter
    l'IntegrityError brute."""
    __tablename__ = 'censeur_classe'

    id = db.Column(db.Integer, primary_key=True)
    censeur_id = db.Column(db.Integer, db.ForeignKey('censeur.id'), nullable=False)
    classe_id = db.Column(db.Integer, db.ForeignKey('classe.id'), nullable=False)

    __table_args__ = (
        # Empêche d'assigner deux fois la même classe au même Censeur.
        db.UniqueConstraint('censeur_id', 'classe_id', name='uq_censeur_classe'),
        # Empêche d'assigner la MÊME classe à DEUX censeurs différents :
        # une classe n'a jamais plus d'un censeur responsable à la fois.
        db.UniqueConstraint('classe_id', name='uq_censeur_classe_unique_classe'),
    )

    censeur = db.relationship('Censeur', backref='classes_assignees', lazy=True)
    classe = db.relationship('Classe', backref='censeurs_assignes', lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in ['id', 'censeur_id', 'classe_id']}


class SurveillantClasse(db.Model):
    """Équivalent de CenseurClasse pour le rôle Surveillant."""
    __tablename__ = 'surveillant_classe'

    id = db.Column(db.Integer, primary_key=True)
    surveillant_id = db.Column(db.Integer, db.ForeignKey('surveillant.id'), nullable=False)
    classe_id = db.Column(db.Integer, db.ForeignKey('classe.id'), nullable=False)

    __table_args__ = (
        db.UniqueConstraint('surveillant_id', 'classe_id', name='uq_surveillant_classe'),
    )

    surveillant = db.relationship('Surveillant', backref='classes_assignees', lazy=True)
    classe = db.relationship('Classe', backref='surveillants_assignes', lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in ['id', 'surveillant_id', 'classe_id']}