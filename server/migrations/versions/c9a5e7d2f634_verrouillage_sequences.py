"""verrouillage de la saisie des notes par séquence

- sequence.etat_saisie : 'auto' (verrouillée le lendemain de sa date de
  fin), 'cloturee' (clôturée par l'administration), 'ouverte' (rouverte
  par l'administration, même après sa date de fin) ;
- sequence.cloturee_le : moment de la clôture manuelle (une saisie faite
  hors connexion AVANT ce moment reste acceptée à la synchronisation).

Revision ID: c9a5e7d2f634
Revises: b8f4d6c1e523
Create Date: 2026-11-17 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'c9a5e7d2f634'
down_revision = 'b8f4d6c1e523'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('sequence', sa.Column('etat_saisie', sa.String(10), nullable=False, server_default='auto'))
    op.add_column('sequence', sa.Column('cloturee_le', sa.DateTime(), nullable=True))


def downgrade():
    op.drop_column('sequence', 'cloturee_le')
    op.drop_column('sequence', 'etat_saisie')
