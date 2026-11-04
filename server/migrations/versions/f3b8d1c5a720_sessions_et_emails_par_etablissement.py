"""sessions par appareil + e-mails uniques par établissement

- session_connexion : une ligne par appareil connecté (refresh token
  haché, rotation). Remplace utilisateur/super_admin.refresh_token_hash,
  qui n'autorisait qu'UNE session par compte (se connecter sur le téléphone
  déconnectait le PC). Les sessions en cours sont perdues : chacun se
  reconnecte une fois après la mise à jour.
- parent / enseignant / censeur / surveillant : l'e-mail n'est plus unique
  sur toute la plateforme mais par établissement (une même personne peut
  figurer dans deux écoles, et une école n'apprend plus qu'un e-mail existe
  ailleurs).

Revision ID: f3b8d1c5a720
Revises: e7a2c4d9f310
Create Date: 2026-11-04 16:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'f3b8d1c5a720'
down_revision = 'e7a2c4d9f310'
branch_labels = None
depends_on = None

TABLES_EMAIL = ('parent', 'enseignant', 'censeur', 'surveillant')


def _contraintes_uniques_email(table):
    """Noms des contraintes UNIQUE portant sur la seule colonne email (créées
    sans nom par le schéma initial : MySQL les a nommées 'email')."""
    inspector = sa.inspect(op.get_bind())
    return [uc['name'] for uc in inspector.get_unique_constraints(table)
            if uc['column_names'] == ['email'] and uc['name']]


def upgrade():
    op.create_table(
        'session_connexion',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('sid', sa.String(length=32), nullable=False),
        sa.Column('type_compte', sa.String(length=16), nullable=False),
        sa.Column('compte_id', sa.Integer(), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('token_precedent_hash', sa.String(length=64), nullable=True),
        sa.Column('rotation_le', sa.DateTime(), nullable=True),
        sa.Column('cree_le', sa.DateTime(), nullable=False),
        sa.Column('expire_le', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_session_connexion_sid', 'session_connexion', ['sid'], unique=True)
    op.create_index('ix_session_connexion_compte', 'session_connexion', ['type_compte', 'compte_id'])

    for table in ('utilisateur', 'super_admin'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_column('refresh_token_hash')
            batch_op.drop_column('refresh_token_expire_le')

    for table in TABLES_EMAIL:
        anciennes = _contraintes_uniques_email(table)
        with op.batch_alter_table(table, schema=None) as batch_op:
            for nom in anciennes:
                batch_op.drop_constraint(nom, type_='unique')
            batch_op.create_unique_constraint(f'uq_{table}_email_etablissement', ['etablissement_id', 'email'])


def downgrade():
    # Échoue volontairement si un même e-mail existe désormais dans deux
    # établissements (la contrainte globale ne peut alors pas être rétablie).
    for table in TABLES_EMAIL:
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.drop_constraint(f'uq_{table}_email_etablissement', type_='unique')
            batch_op.create_unique_constraint('email', ['email'])

    for table in ('utilisateur', 'super_admin'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.add_column(sa.Column('refresh_token_hash', sa.String(length=255), nullable=True))
            batch_op.add_column(sa.Column('refresh_token_expire_le', sa.DateTime(), nullable=True))

    op.drop_index('ix_session_connexion_compte', table_name='session_connexion')
    op.drop_index('ix_session_connexion_sid', table_name='session_connexion')
    op.drop_table('session_connexion')
