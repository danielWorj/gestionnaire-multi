"""trésorerie hors connexion : clé d'idempotence des opérations

Une opération saisie sans réseau porte un identifiant généré par l'appareil :
si l'envoi est rejoué (réponse perdue), le serveur renvoie l'opération déjà
enregistrée au lieu de la créer une seconde fois.

Revision ID: c8a4f1e6b273
Revises: b5e9d2f7a316
Create Date: 2026-11-12 15:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'c8a4f1e6b273'
down_revision = 'b5e9d2f7a316'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('mouvement_tresorerie', schema=None) as batch_op:
        batch_op.add_column(sa.Column('cle_idempotence', sa.String(length=40), nullable=True))
        batch_op.create_unique_constraint('uq_mouvement_cle_idempotence', ['cle_idempotence'])


def downgrade():
    with op.batch_alter_table('mouvement_tresorerie', schema=None) as batch_op:
        batch_op.drop_constraint('uq_mouvement_cle_idempotence', type_='unique')
        batch_op.drop_column('cle_idempotence')
