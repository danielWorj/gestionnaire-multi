from datetime import datetime

from extensions import db


class JournalAudit(db.Model):
    """Journal d'audit : une ligne par création, modification ou suppression
    d'une donnée, quelle que soit la table (cf. services/audit_services.py,
    qui l'alimente automatiquement à chaque flush SQLAlchemy).

    Écrit dans la MÊME transaction que la donnée elle-même : si le journal ne
    peut pas être écrit, la modification est annulée — l'historique est donc
    toujours complet, ce qui en fait une preuve fiable en cas de litige.

    Volontairement SANS clé étrangère : l'historique d'une ligne (ou d'un
    auteur) doit survivre à sa suppression. Les informations de l'auteur
    (nom, rôle) sont figées au moment de l'action, pour la même raison.

    `changements` : { champ: [avant, après] } (avant = null à la création,
    après = null à la suppression). Les secrets (hash de PIN / mot de passe)
    n'y apparaissent jamais en clair.

    `saisi_hors_ligne_le` : pour une donnée saisie sans connexion puis
    synchronisée, l'heure de la saisie réelle sur l'appareil (l'horodatage
    `horodatage` étant celui de l'arrivée au serveur)."""
    __tablename__ = 'journal_audit'

    id = db.Column(db.BigInteger().with_variant(db.Integer, 'sqlite'), primary_key=True, autoincrement=True)
    horodatage = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    action = db.Column(db.String(12), nullable=False)  # creation | modification | suppression
    table_nom = db.Column(db.String(64), nullable=False)
    ligne_id = db.Column(db.String(64), nullable=False)
    version_ligne = db.Column(db.Integer, nullable=True)
    etablissement_id = db.Column(db.Integer, nullable=True)

    auteur_type = db.Column(db.String(12), nullable=False)  # utilisateur | superadmin | systeme | anonyme
    auteur_id = db.Column(db.Integer, nullable=True)
    auteur_nom = db.Column(db.String(150), nullable=True)
    auteur_role = db.Column(db.String(50), nullable=True)
    adresse_ip = db.Column(db.String(45), nullable=True)
    saisi_hors_ligne_le = db.Column(db.DateTime, nullable=True)

    changements = db.Column(db.JSON, nullable=True)

    __table_args__ = (
        db.Index('ix_audit_ligne', 'table_nom', 'ligne_id'),
        db.Index('ix_audit_etablissement_date', 'etablissement_id', 'horodatage'),
        db.Index('ix_audit_auteur', 'auteur_type', 'auteur_id'),
    )

    def to_dict(self):
        return {
            'id': self.id,
            'horodatage': self.horodatage.isoformat() if self.horodatage else None,
            'action': self.action,
            'table': self.table_nom,
            'ligne_id': self.ligne_id,
            'version': self.version_ligne,
            'etablissement_id': self.etablissement_id,
            'auteur': {
                'type': self.auteur_type,
                'id': self.auteur_id,
                'nom': self.auteur_nom,
                'role': self.auteur_role,
            },
            'adresse_ip': self.adresse_ip,
            'saisi_hors_ligne_le': self.saisi_hors_ligne_le.isoformat() if self.saisi_hors_ligne_le else None,
            'changements': self.changements or {},
        }


class Versionne:
    """Mixin des tables synchronisées hors connexion : `version` augmente de 1
    à chaque modification effective (cf. audit_services, before_flush).

    Une saisie hors ligne mémorise la version qu'elle a vue ; si, à la
    synchronisation, le serveur est passé à une version supérieure, quelqu'un
    d'autre a modifié la donnée entre-temps : c'est un conflit, que
    l'utilisateur tranche (écraser ou ignorer), le journal disant qui a fait
    la modification concurrente et quand."""
    version = db.Column(db.Integer, nullable=False, default=1, server_default='1')
