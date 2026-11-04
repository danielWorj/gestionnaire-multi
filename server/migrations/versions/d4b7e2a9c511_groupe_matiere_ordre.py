"""groupe_matiere ordre

Ajoute groupe_matiere.ordre : rang d'affichage des groupes de matières sur
les bulletins.

Revision ID: d4b7e2a9c511
Revises: c3a91f2d7e10
Create Date: 2026-11-02 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd4b7e2a9c511'
down_revision = 'c3a91f2d7e10'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('groupe_matiere', schema=None) as batch_op:
        batch_op.add_column(sa.Column('ordre', sa.Integer(), nullable=False, server_default='0'))


def downgrade():
    with op.batch_alter_table('groupe_matiere', schema=None) as batch_op:
        batch_op.drop_column('ordre')
