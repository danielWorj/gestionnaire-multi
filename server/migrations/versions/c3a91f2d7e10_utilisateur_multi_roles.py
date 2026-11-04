"""utilisateur multi roles

Remplace la colonne utilisateur.role_id (un seul rôle) par la table
d'association utilisateur_role (plusieurs rôles par compte). Le rôle existant
de chaque utilisateur y est recopié avant la suppression de la colonne.

Revision ID: c3a91f2d7e10
Revises: b8e631be3b4f
Create Date: 2026-11-01 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'c3a91f2d7e10'
down_revision = 'b8e631be3b4f'
branch_labels = None
depends_on = None


def _fk_role_id_utilisateur():
    """Nom de la clé étrangère utilisateur.role_id -> role.id : elle a été
    créée sans nom explicite (schéma initial), donc nommée par le SGBD
    (ex : 'utilisateur_ibfk_2' sous MySQL)."""
    inspector = sa.inspect(op.get_bind())
    for fk in inspector.get_foreign_keys('utilisateur'):
        if fk['constrained_columns'] == ['role_id']:
            return fk['name']
    return None


def upgrade():
    op.create_table('utilisateur_role',
    sa.Column('utilisateur_id', sa.Integer(), nullable=False),
    sa.Column('role_id', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['role_id'], ['role.id'], ),
    sa.ForeignKeyConstraint(['utilisateur_id'], ['utilisateur.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('utilisateur_id', 'role_id')
    )

    op.execute(
        'INSERT INTO utilisateur_role (utilisateur_id, role_id) '
        'SELECT id, role_id FROM utilisateur WHERE role_id IS NOT NULL'
    )

    fk_name = _fk_role_id_utilisateur()
    with op.batch_alter_table('utilisateur', schema=None) as batch_op:
        if fk_name:
            batch_op.drop_constraint(fk_name, type_='foreignkey')
        batch_op.drop_column('role_id')


def downgrade():
    # Un compte multi-rôles ne garde que son rôle de plus petit id.
    with op.batch_alter_table('utilisateur', schema=None) as batch_op:
        batch_op.add_column(sa.Column('role_id', sa.Integer(), nullable=True))

    op.execute(
        'UPDATE utilisateur SET role_id = ('
        'SELECT MIN(ur.role_id) FROM utilisateur_role ur WHERE ur.utilisateur_id = utilisateur.id)'
    )

    with op.batch_alter_table('utilisateur', schema=None) as batch_op:
        batch_op.alter_column('role_id', existing_type=sa.Integer(), nullable=False)
        batch_op.create_foreign_key('fk_utilisateur_role_id', 'role', ['role_id'], ['id'])

    op.drop_table('utilisateur_role')
