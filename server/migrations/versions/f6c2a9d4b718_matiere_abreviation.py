"""matière : abréviation (en-tête de colonne du procès-verbal)

Colonne facultative matiere.abreviation (12 caractères max) : « Angl »,
« SVTEEHB »… Utilisée comme titre de colonne sur le procès-verbal
d'évaluation ; à défaut, les 5 premiers caractères du libellé.

Revision ID: f6c2a9d4b718
Revises: d9b3a5f7c264
Create Date: 2026-11-14 15:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'f6c2a9d4b718'
down_revision = 'd9b3a5f7c264'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('matiere', sa.Column('abreviation', sa.String(12), nullable=True))


def downgrade():
    op.drop_column('matiere', 'abreviation')
