"""modèle de bulletin par établissement (etablissement.modele_bulletin)

Chaque établissement existant reçoit le modèle original de son mode d'évaluation.

Revision ID: b8f4d6c1e523
Revises: a7e3c5b9d412
Create Date: 2026-11-16 14:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b8f4d6c1e523'
down_revision = 'a7e3c5b9d412'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('etablissement', sa.Column('modele_bulletin', sa.String(30), nullable=False,
                                             server_default='original'))
    op.execute("UPDATE etablissement SET modele_bulletin = 'original_college' WHERE mode_evaluation = 'college'")
    op.execute("UPDATE etablissement SET modele_bulletin = 'original_institut' WHERE mode_evaluation = 'institut'")


def downgrade():
    op.drop_column('etablissement', 'modele_bulletin')
