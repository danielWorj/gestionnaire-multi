from extensions import db

JOURS_SEMAINE = ('Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi')


class CreneauHoraire(db.Model):
    """Référentiel des créneaux horaires (ex : 8h-9h, 9h-10h, ...), CLOISONNÉ
    par etablissement_id : chaque établissement gère sa propre grille de
    créneaux (deux établissements peuvent avoir des découpages horaires
    différents) — même logique que les référentiels pédagogiques
    (GroupeMatiere, Departement, Grade, ... cf. pedagogie_models.py), et non
    plus celle de Etablissement dans structure_models.py (cf.
    emploi_du_temps_api.creneau_horaire_bp, calqué sur le blueprint scopé de
    pedagogie_api.py)."""
    __tablename__ = 'creneau_horaire'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    libelle = db.Column(db.String(50), nullable=False)
    heure_debut = db.Column(db.Time, nullable=False)
    heure_fin = db.Column(db.Time, nullable=False)

    horaires = db.relationship('Horaire', backref='creneau', lazy=True)
    etablissement = db.relationship('Etablissement', backref='creneaux_horaires', lazy=True)

    def to_dict(self):
        d = {"id": self.id, "etablissement_id": self.etablissement_id, "libelle": self.libelle}
        if self.heure_debut:
            d['heure_debut'] = self.heure_debut.isoformat()
        if self.heure_fin:
            d['heure_fin'] = self.heure_fin.isoformat()
        return d


class Horaire(db.Model):
    """Une case de l'emploi du temps : la MatiereClasse (couple
    classe/matière/enseignant, cf. pedagogie_models.py) programmée un jour
    donné, sur un créneau donné, pour une année scolaire donnée.

    Pas de etablissement_id, classe_id ni enseignant_id directs : classe_id
    et enseignant_id sont accessibles via matiere_classe (jointure), pas
    dupliqués ici — même logique que TitulaireClasse/MatiereClasse dans
    pedagogie_models.py, mais avec un saut de jointure supplémentaire
    (matiere_classe_id -> MatiereClasse.classe_id -> Classe.etablissement_id,
    cf. emploi_du_temps_services.get_etablissement_id_of).

    uq_horaire_matiere_classe_creneau empêche seulement la double saisie de
    la MEME MatiereClasse sur le même créneau/jour/année. Elle ne détecte PAS
    les collisions classe/enseignant (deux MatiereClasse distinctes peuvent
    quand même se chevaucher si elles partagent la même classe ou le même
    enseignant) : cette détection est gérée côté application, via une requête
    joignant Horaire -> MatiereClasse avant chaque insertion/génération (cf.
    emploi_du_temps_services._check_collisions)."""
    __tablename__ = 'horaire'

    id = db.Column(db.Integer, primary_key=True)
    matiere_classe_id = db.Column(db.Integer, db.ForeignKey('matiere_classe.id'), nullable=False)
    annee_scolaire_id = db.Column(db.Integer, db.ForeignKey('annee_scolaire.id'), nullable=False)
    jour_semaine = db.Column(db.String(10), nullable=False)
    creneau_id = db.Column(db.Integer, db.ForeignKey('creneau_horaire.id'), nullable=False)
    salle = db.Column(db.String(30))

    __table_args__ = (
        db.CheckConstraint(
            "jour_semaine IN ('Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi')",
            name='ck_horaire_jour'
        ),
        db.UniqueConstraint(
            'matiere_classe_id', 'jour_semaine', 'creneau_id', 'annee_scolaire_id',
            name='uq_horaire_matiere_classe_creneau'
        ),
    )

    matiere_classe = db.relationship('MatiereClasse', backref='horaires', lazy=True)
    annee_scolaire = db.relationship('AnneeScolaire', backref='horaires', lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ['id', 'matiere_classe_id', 'annee_scolaire_id', 'jour_semaine',
                 'creneau_id', 'salle']}