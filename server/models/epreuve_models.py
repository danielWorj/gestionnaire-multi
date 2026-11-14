from datetime import datetime

from extensions import db


# ---------------------------------------------------------------------------
# Epreuve — un document (PDF, Word, image) déposé par un enseignant, ou par
# l'administration pour son compte, dans l'une des classes où il enseigne.
#
# Rattachée à une MatiereClasse (classe + matière + enseignant), ce qui
# garantit qu'une épreuve appartient toujours à une classe ET à une matière
# réellement enseignées, et que l'enseignant est celui de l'affectation.
#
# Cloisonnement DIRECT par établissement (colonne etablissement_id, comme
# Enseignant / Matiere) : les listes filtrent dessus sans jointure.
#
# Le fichier vit sur disque, jamais en base : storage/epreuves/<etab_id>/
# sous un nom ALÉATOIRE (`fichier`), jamais dérivé du nom envoyé par
# l'utilisateur. `nom_original` ne sert qu'à nommer le téléchargement.
#
# `enseignant_id` est celui de la MatiereClasse AU MOMENT du dépôt : si
# l'affectation change plus tard, l'épreuve reste attribuée à son auteur.
#
# Volontairement non Versionne : pas de saisie hors connexion pour cette
# table (cf. web/src/lib/epreuves.js). L'audit, lui, est automatique
# (services/audit_services.py).
# ---------------------------------------------------------------------------

class Epreuve(db.Model):
    __tablename__ = 'epreuve'

    id = db.Column(db.Integer, primary_key=True)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    matiere_classe_id = db.Column(db.Integer, db.ForeignKey('matiere_classe.id'), nullable=False)
    enseignant_id = db.Column(db.Integer, db.ForeignKey('enseignant.id'), nullable=False)
    annee_scolaire_id = db.Column(db.Integer, db.ForeignKey('annee_scolaire.id'), nullable=False)

    titre = db.Column(db.String(150), nullable=False)
    nom_original = db.Column(db.String(255), nullable=False)
    fichier = db.Column(db.String(64), nullable=False)
    mime = db.Column(db.String(100), nullable=False)
    taille = db.Column(db.Integer, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        db.Index('ix_epreuve_etab_mc', 'etablissement_id', 'matiere_classe_id'),
        db.Index('ix_epreuve_etab_enseignant', 'etablissement_id', 'enseignant_id'),
    )

    matiere_classe = db.relationship('MatiereClasse', backref='epreuves', lazy=True)
    enseignant = db.relationship('Enseignant', backref='epreuves', lazy=True)
    annee_scolaire = db.relationship('AnneeScolaire', backref='epreuves', lazy=True)

    def to_dict(self):
        """Champs propres à l'épreuve. Le nom du fichier sur disque (`fichier`)
        n'est jamais exposé ; les libellés de classe / matière / enseignant
        sont ajoutés par epreuve_services (jointure unique, pas de N+1)."""
        return {
            'id': self.id,
            'etablissement_id': self.etablissement_id,
            'matiere_classe_id': self.matiere_classe_id,
            'enseignant_id': self.enseignant_id,
            'annee_scolaire_id': self.annee_scolaire_id,
            'titre': self.titre,
            'nom_original': self.nom_original,
            'mime': self.mime,
            'taille': self.taille,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }
