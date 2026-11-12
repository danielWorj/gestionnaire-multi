from datetime import datetime

from extensions import db


# Types de notification (cf. services/notification_services.py, qui est le
# seul à en créer). Le front choisit l'icône et la couleur d'après le type.
TYPES_NOTIFICATION = (
    'echeance_paiement',     # Parent : tranche à régler bientôt / aujourd'hui
    'retard_paiement',       # Parent : tranche échue impayée (bulletin suspendu)
    'fin_sequence',          # Enseignant : la séquence se termine bientôt
    'saisie_incomplete',     # Enseignant : notes manquantes à l'approche de la fin
    'recap_saisie',          # Admin : récapitulatif hebdomadaire de la saisie
)
NIVEAUX_NOTIFICATION = ('info', 'alerte', 'urgent')


class Notification(db.Model):
    """Notification affichée dans l'application (cloche de la barre du haut).

    Destinée à un compte ET à l'un de ses rôles : un compte multi-rôles (ex.
    l'Admin qui enseigne aussi) ne voit dans un espace que les notifications
    de cet espace.

    `cle` identifie l'événement notifié (ex. 'echeance|<inscription>|<tranche>|J7') :
    uq_notification garantit qu'un même événement n'est jamais notifié deux
    fois au même destinataire, même si la génération tourne plusieurs fois
    par jour ou sur plusieurs processus en parallèle.

    Hors du journal d'audit (cf. audit_services.TABLES_EXCLUES) : donnée
    technique, régénérée à partir des données métier."""
    __tablename__ = 'notification'

    id = db.Column(db.Integer, primary_key=True)
    utilisateur_id = db.Column(db.Integer, db.ForeignKey('utilisateur.id', ondelete='CASCADE'), nullable=False)
    role = db.Column(db.String(50), nullable=False)
    etablissement_id = db.Column(db.Integer, db.ForeignKey('etablissement.id'), nullable=False)
    type = db.Column(db.String(30), nullable=False)
    niveau = db.Column(db.String(10), nullable=False, default='info')
    titre = db.Column(db.String(150), nullable=False)
    message = db.Column(db.String(600), nullable=False)
    # Route du front à ouvrir au clic (ex. '/parent/paiements'), ou NULL.
    lien = db.Column(db.String(255), nullable=True)
    cle = db.Column(db.String(150), nullable=False)
    cree_le = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    lue_le = db.Column(db.DateTime, nullable=True)

    __table_args__ = (
        db.UniqueConstraint('utilisateur_id', 'role', 'cle', name='uq_notification'),
        db.Index('ix_notification_destinataire', 'utilisateur_id', 'role', 'lue_le'),
        db.CheckConstraint("niveau IN ('info', 'alerte', 'urgent')", name='ck_notification_niveau'),
    )

    def to_dict(self):
        return {
            'id': self.id,
            'type': self.type,
            'niveau': self.niveau,
            'titre': self.titre,
            'message': self.message,
            'lien': self.lien,
            # UTC naïf en base : le 'Z' évite une lecture en heure locale.
            'cree_le': self.cree_le.isoformat() + 'Z' if self.cree_le else None,
            'lue': self.lue_le is not None,
        }
