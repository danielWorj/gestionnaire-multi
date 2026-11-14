"""épreuves : documents déposés par les enseignants

Table epreuve : une épreuve (PDF, Word ou image) rattachée à une
matière-classe (classe + matière + enseignant) et à une année scolaire. Le
fichier est stocké sur disque (storage/epreuves/<etablissement_id>/), la base
ne garde que ses métadonnées.

Revision ID: d9b3a5f7c264
Revises: c8a4f1e6b273
Create Date: 2026-11-14 09:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd9b3a5f7c264'
down_revision = 'c8a4f1e6b273'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'epreuve',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('etablissement_id', sa.Integer(), nullable=False),
        sa.Column('matiere_classe_id', sa.Integer(), nullable=False),
        sa.Column('enseignant_id', sa.Integer(), nullable=False),
        sa.Column('annee_scolaire_id', sa.Integer(), nullable=False),
        sa.Column('titre', sa.String(length=150), nullable=False),
        sa.Column('nom_original', sa.String(length=255), nullable=False),
        sa.Column('fichier', sa.String(length=64), nullable=False),
        sa.Column('mime', sa.String(length=100), nullable=False),
        sa.Column('taille', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['etablissement_id'], ['etablissement.id']),
        sa.ForeignKeyConstraint(['matiere_classe_id'], ['matiere_classe.id']),
        sa.ForeignKeyConstraint(['enseignant_id'], ['enseignant.id']),
        sa.ForeignKeyConstraint(['annee_scolaire_id'], ['annee_scolaire.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_epreuve_etab_mc', 'epreuve', ['etablissement_id', 'matiere_classe_id'])
    op.create_index('ix_epreuve_etab_enseignant', 'epreuve', ['etablissement_id', 'enseignant_id'])


def downgrade():
    op.drop_index('ix_epreuve_etab_enseignant', table_name='epreuve')
    op.drop_index('ix_epreuve_etab_mc', table_name='epreuve')
    op.drop_table('epreuve')
