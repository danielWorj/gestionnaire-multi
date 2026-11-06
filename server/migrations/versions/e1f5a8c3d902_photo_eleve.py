"""photo eleve

Ajoute eleve.photo : nom du fichier de la photo d'identité de l'élève
(storage/photos_eleves/<etablissement_id>/), affichée sur sa fiche et en
en-tête de son bulletin.

Revision ID: e1f5a8c3d902
Revises: c7d2e8f4a915
Create Date: 2026-11-06 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e1f5a8c3d902'
down_revision = 'c7d2e8f4a915'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('eleve', schema=None) as batch_op:
        batch_op.add_column(sa.Column('photo', sa.String(length=255), nullable=True))


def downgrade():
    with op.batch_alter_table('eleve', schema=None) as batch_op:
        batch_op.drop_column('photo')
