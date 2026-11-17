"""dispenses : matière dont le coefficient est annulé pour un élève sur une séquence

Revision ID: d1b6f8e3a745
Revises: c9a5e7d2f634
Create Date: 2026-11-17 13:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'd1b6f8e3a745'
down_revision = 'c9a5e7d2f634'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'dispense',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('inscription_id', sa.Integer(), nullable=False),
        sa.Column('matiere_classe_id', sa.Integer(), nullable=False),
        sa.Column('sequence_id', sa.Integer(), nullable=False),
        sa.Column('motif', sa.String(255), nullable=True),
        sa.Column('cree_le', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['inscription_id'], ['inscription.id']),
        sa.ForeignKeyConstraint(['matiere_classe_id'], ['matiere_classe.id']),
        sa.ForeignKeyConstraint(['sequence_id'], ['sequence.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('inscription_id', 'matiere_classe_id', 'sequence_id', name='uq_dispense'),
    )


def downgrade():
    op.drop_table('dispense')
