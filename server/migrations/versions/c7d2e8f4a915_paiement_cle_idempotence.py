"""Paiement : clé d'idempotence (saisie hors connexion)

Un paiement saisi sans connexion porte un identifiant unique généré par
l'appareil : si son envoi est rejoué (réponse perdue), le serveur retrouve
le paiement déjà enregistré au lieu d'encaisser deux fois. NULL pour les
paiements existants et pour ceux saisis en ligne sans clé.

Revision ID: c7d2e8f4a915
Revises: b2c6f9a1d834
Create Date: 2026-11-05 22:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'c7d2e8f4a915'
down_revision = 'b2c6f9a1d834'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('paiement') as batch:
        batch.add_column(sa.Column('cle_idempotence', sa.String(length=40), nullable=True))
        batch.create_unique_constraint('uq_paiement_cle_idempotence', ['cle_idempotence'])


def downgrade():
    with op.batch_alter_table('paiement') as batch:
        batch.drop_constraint('uq_paiement_cle_idempotence', type_='unique')
        batch.drop_column('cle_idempotence')
