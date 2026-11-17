"""niveaux : regroupement des classes parallèles (6e A, 6e B -> 6e)

Revision ID: e2c7a9f4b856
Revises: d1b6f8e3a745
Create Date: 2026-11-17 14:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'e2c7a9f4b856'
down_revision = 'd1b6f8e3a745'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'niveau',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('etablissement_id', sa.Integer(), nullable=False),
        sa.Column('libelle', sa.String(50), nullable=False),
        sa.Column('ordre', sa.Integer(), nullable=False, server_default='0'),
        sa.ForeignKeyConstraint(['etablissement_id'], ['etablissement.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('etablissement_id', 'libelle', name='uq_niveau_etablissement'),
    )
    with op.batch_alter_table('classe') as batch:
        batch.add_column(sa.Column('niveau_id', sa.Integer(), nullable=True))
        batch.create_foreign_key('fk_classe_niveau', 'niveau', ['niveau_id'], ['id'])


def downgrade():
    with op.batch_alter_table('classe') as batch:
        batch.drop_constraint('fk_classe_niveau', type_='foreignkey')
        batch.drop_column('niveau_id')
    op.drop_table('niveau')
