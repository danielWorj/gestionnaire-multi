"""connexion par code + PIN

- etablissement.code : code court (4 caractères) attribué à chaque
  établissement, unique.
- utilisateur.code_connexion : identifiant de connexion (4 caractères),
  unique sur toute la plateforme ; remplace l'email pour se connecter.
- utilisateur.echecs_connexion / verrouille_jusqua : verrouillage du compte
  après trop de PIN faux.
- Les emails deviennent facultatifs (utilisateur, enseignant, censeur,
  surveillant).

Les comptes existants reçoivent un code, mais leur ancien mot de passe ne
peut pas servir de PIN : lancer ensuite `python reinitialiser_pins.py` pour
leur attribuer un PIN temporaire et produire les fiches d'accès.

Revision ID: e7a2c4d9f310
Revises: d4b7e2a9c511
Create Date: 2026-11-04 10:00:00.000000

"""
import secrets

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e7a2c4d9f310'
down_revision = 'd4b7e2a9c511'
branch_labels = None
depends_on = None

# Copie figée de models/authentification_models.CODE_ALPHABET : une
# migration ne doit pas dépendre du code applicatif, qui peut évoluer.
CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789'


def _attribuer_codes(table, colonne):
    bind = op.get_bind()
    ids = [row[0] for row in bind.execute(sa.text(f'SELECT id FROM {table} ORDER BY id'))]
    pris = set()
    for id_ in ids:
        code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(4))
        while code in pris:
            code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(4))
        pris.add(code)
        bind.execute(sa.text(f'UPDATE {table} SET {colonne} = :code WHERE id = :id'), {'code': code, 'id': id_})


def upgrade():
    with op.batch_alter_table('etablissement', schema=None) as batch_op:
        batch_op.add_column(sa.Column('code', sa.String(length=4), nullable=True))
    _attribuer_codes('etablissement', 'code')
    with op.batch_alter_table('etablissement', schema=None) as batch_op:
        batch_op.alter_column('code', existing_type=sa.String(length=4), nullable=False)
        batch_op.create_unique_constraint('uq_etablissement_code', ['code'])

    with op.batch_alter_table('utilisateur', schema=None) as batch_op:
        batch_op.add_column(sa.Column('code_connexion', sa.String(length=4), nullable=True))
        batch_op.add_column(sa.Column('echecs_connexion', sa.Integer(), nullable=False, server_default='0'))
        batch_op.add_column(sa.Column('verrouille_jusqua', sa.DateTime(), nullable=True))
        batch_op.alter_column('email', existing_type=sa.String(length=150), nullable=True)
    _attribuer_codes('utilisateur', 'code_connexion')
    with op.batch_alter_table('utilisateur', schema=None) as batch_op:
        batch_op.alter_column('code_connexion', existing_type=sa.String(length=4), nullable=False)
        batch_op.create_unique_constraint('uq_utilisateur_code_connexion', ['code_connexion'])

    for table in ('enseignant', 'censeur', 'surveillant'):
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column('email', existing_type=sa.String(length=150), nullable=True)


def downgrade():
    # Les emails vides n'ont pas d'équivalent dans l'ancien schéma (NOT
    # NULL) : on y met une adresse factice unique pour pouvoir revenir en
    # arrière sans perdre de ligne.
    for table in ('enseignant', 'censeur', 'surveillant', 'utilisateur'):
        op.execute(
            f"UPDATE {table} SET email = CONCAT('{table}-', id, '@sans-email.invalid') WHERE email IS NULL"
        )
        with op.batch_alter_table(table, schema=None) as batch_op:
            batch_op.alter_column('email', existing_type=sa.String(length=150), nullable=False)

    with op.batch_alter_table('utilisateur', schema=None) as batch_op:
        batch_op.drop_constraint('uq_utilisateur_code_connexion', type_='unique')
        batch_op.drop_column('verrouille_jusqua')
        batch_op.drop_column('echecs_connexion')
        batch_op.drop_column('code_connexion')

    with op.batch_alter_table('etablissement', schema=None) as batch_op:
        batch_op.drop_constraint('uq_etablissement_code', type_='unique')
        batch_op.drop_column('code')
