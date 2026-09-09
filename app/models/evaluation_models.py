from datetime import datetime
from extensions import db


# ---------------------------------------------------------------------------
# Note, Discipline — cloisonnées par établissement, mais AUCUNE des deux ne
# porte de colonne etablissement_id directe (comme Horaire dans
# emploi_du_temps_models.py) :
#
# - Discipline se déduit d'UN saut : inscription_id -> Inscription.classe_id
#   -> Classe.etablissement_id (même logique que Inscription elle-même,
#   cf. inscription_models.py).
#
# - Note se déduit de DEUX chemins qui doivent rester cohérents entre eux
#   (vérifié côté service, cf. evaluation_service._validate_note_coherence) :
#     * inscription_id -> Inscription.classe_id -> Classe.etablissement_id
#     * matiere_classe_id -> MatiereClasse.classe_id -> Classe.etablissement_id
#   Une Note n'a de sens que si l'élève inscrit (inscription_id) et la
#   matière-classe notée (matiere_classe_id) portent sur la MÊME classe —
#   c'est cette cohérence, vérifiée à la création/modification, qui garantit
#   que les deux chemins convergent toujours vers le même établissement.
#
# Droits d'accès (cf. evaluation_api.py pour le détail) :
# - Note      : lecture pour Admin/SuperAdmin/Censeur/Surveillant/Enseignant ;
#               écriture réservée au SEUL Enseignant, et uniquement sur SES
#               PROPRES MatiereClasse (celles qui lui ont été attribuées par
#               l'Admin, cf. MatiereClasse.enseignant_id).
# - Discipline : lecture ET écriture réservées à Censeur/Surveillant (+
#               Admin/SuperAdmin) — l'Enseignant n'y a aucun accès, ni en
#               lecture ni en écriture.
# ---------------------------------------------------------------------------


class Note(db.Model):
    """Une note attribuée à un élève inscrit (Inscription), pour une
    MatiereClasse (couple classe/matière/enseignant) donnée, sur une
    Sequence donnée. uq_note garantit qu'un élève n'a qu'une seule note par
    matière-classe et par séquence : une correction se fait via PUT sur la
    ligne existante, jamais par une nouvelle insertion.

    valeur est nullable : un élève marqué absent (absent=True) n'a en
    général pas de valeur chiffrée — le champ 'absent' porte cette
    information séparément plutôt que de forcer une valeur conventionnelle
    (0, NULL-as-zero, etc.) qui fausserait les moyennes. ck_note_valeur
    n'impose la plage [0, 20] QUE lorsque valeur est renseignée."""
    __tablename__ = 'note'

    id = db.Column(db.Integer, primary_key=True)
    inscription_id = db.Column(db.Integer, db.ForeignKey('inscription.id'), nullable=False)
    matiere_classe_id = db.Column(db.Integer, db.ForeignKey('matiere_classe.id'), nullable=False)
    sequence_id = db.Column(db.Integer, db.ForeignKey('sequence.id'), nullable=False)
    valeur = db.Column(db.Numeric(5, 2), nullable=True)
    absent = db.Column(db.Boolean, nullable=False, default=False)
    saisie_le = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        db.UniqueConstraint('inscription_id', 'matiere_classe_id', 'sequence_id', name='uq_note'),
        db.CheckConstraint('valeur IS NULL OR (valeur >= 0 AND valeur <= 20)', name='ck_note_valeur'),
    )

    inscription = db.relationship('Inscription', backref='notes', lazy=True)
    matiere_classe = db.relationship('MatiereClasse', backref='notes', lazy=True)
    sequence = db.relationship('Sequence', backref='notes', lazy=True)

    def to_dict(self):
        d = {k: getattr(self, k) for k in
             ['id', 'inscription_id', 'matiere_classe_id', 'sequence_id', 'absent']}
        d['valeur'] = float(self.valeur) if self.valeur is not None else None
        d['saisie_le'] = self.saisie_le.isoformat() if self.saisie_le else None
        return d


class Discipline(db.Model):
    """Le suivi disciplinaire d'un élève inscrit (Inscription), pour une
    Sequence donnée : absences (justifiées / non justifiées), retards,
    exclusions, observation libre. uq_discipline garantit une seule fiche
    par inscription et par séquence — les compteurs se mettent à jour via
    PUT sur la ligne existante plutôt que par accumulation de lignes.

    Pas de etablissement_id direct : déduit de inscription_id ->
    Inscription.classe_id -> Classe.etablissement_id (même logique que
    Inscription elle-même, cf. inscription_services.get_etablissement_id_of)."""
    __tablename__ = 'discipline'

    id = db.Column(db.Integer, primary_key=True)
    inscription_id = db.Column(db.Integer, db.ForeignKey('inscription.id'), nullable=False)
    sequence_id = db.Column(db.Integer, db.ForeignKey('sequence.id'), nullable=False)
    absences_justifiees = db.Column(db.Integer, nullable=False, default=0)
    absences_non_justifiees = db.Column(db.Integer, nullable=False, default=0)
    retards = db.Column(db.Integer, nullable=False, default=0)
    exclusions = db.Column(db.Integer, nullable=False, default=0)
    observation = db.Column(db.Text, nullable=True)

    __table_args__ = (
        db.UniqueConstraint('inscription_id', 'sequence_id', name='uq_discipline'),
        db.CheckConstraint('absences_justifiees >= 0', name='ck_discipline_absences_justifiees'),
        db.CheckConstraint('absences_non_justifiees >= 0', name='ck_discipline_absences_non_justifiees'),
        db.CheckConstraint('retards >= 0', name='ck_discipline_retards'),
        db.CheckConstraint('exclusions >= 0', name='ck_discipline_exclusions'),
    )

    inscription = db.relationship('Inscription', backref='disciplines', lazy=True)
    sequence = db.relationship('Sequence', backref='disciplines', lazy=True)

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ['id', 'inscription_id', 'sequence_id', 'absences_justifiees',
                 'absences_non_justifiees', 'retards', 'exclusions', 'observation']}