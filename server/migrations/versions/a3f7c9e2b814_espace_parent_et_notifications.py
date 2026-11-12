"""espace parent et notifications

- parent.utilisateur_id : compte de connexion de la famille à l'espace
  parent (un compte par parent, quel que soit le nombre d'enfants) ;
- inscription.bulletin_debloque : levée par l'administration du blocage du
  bulletin dans l'espace parent (frais échus impayés) ;
- table notification : notifications affichées dans l'application.

Revision ID: a3f7c9e2b814
Revises: e1f5a8c3d902
Create Date: 2026-11-10 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a3f7c9e2b814'
down_revision = 'e1f5a8c3d902'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('parent', schema=None) as batch_op:
        batch_op.add_column(sa.Column('utilisateur_id', sa.Integer(), nullable=True))
        batch_op.create_unique_constraint('uq_parent_utilisateur', ['utilisateur_id'])
        batch_op.create_foreign_key('fk_parent_utilisateur', 'utilisateur', ['utilisateur_id'], ['id'])

    with op.batch_alter_table('inscription', schema=None) as batch_op:
        batch_op.add_column(sa.Column('bulletin_debloque', sa.Boolean(), nullable=False,
                                      server_default=sa.false()))

    op.create_table(
        'notification',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('utilisateur_id', sa.Integer(), nullable=False),
        sa.Column('role', sa.String(length=50), nullable=False),
        sa.Column('etablissement_id', sa.Integer(), nullable=False),
        sa.Column('type', sa.String(length=30), nullable=False),
        sa.Column('niveau', sa.String(length=10), nullable=False),
        sa.Column('titre', sa.String(length=150), nullable=False),
        sa.Column('message', sa.String(length=600), nullable=False),
        sa.Column('lien', sa.String(length=255), nullable=True),
        sa.Column('cle', sa.String(length=150), nullable=False),
        sa.Column('cree_le', sa.DateTime(), nullable=False),
        sa.Column('lue_le', sa.DateTime(), nullable=True),
        sa.CheckConstraint("niveau IN ('info', 'alerte', 'urgent')", name='ck_notification_niveau'),
        sa.ForeignKeyConstraint(['utilisateur_id'], ['utilisateur.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['etablissement_id'], ['etablissement.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('utilisateur_id', 'role', 'cle', name='uq_notification'),
    )
    op.create_index('ix_notification_destinataire', 'notification', ['utilisateur_id', 'role', 'lue_le'])


def downgrade():
    op.drop_index('ix_notification_destinataire', table_name='notification')
    op.drop_table('notification')

    with op.batch_alter_table('inscription', schema=None) as batch_op:
        batch_op.drop_column('bulletin_debloque')

    with op.batch_alter_table('parent', schema=None) as batch_op:
        batch_op.drop_constraint('fk_parent_utilisateur', type_='foreignkey')
        batch_op.drop_constraint('uq_parent_utilisateur', type_='unique')
        batch_op.drop_column('utilisateur_id')
