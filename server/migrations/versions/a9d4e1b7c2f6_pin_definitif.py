"""PIN définitif : plus d'expiration ni de changement imposé

Le PIN généré à la création d'un compte (ou à une réinitialisation) n'est
plus temporaire : il n'expire plus au bout de 48h et la personne n'est plus
obligée de le changer à sa première connexion (elle peut le faire quand elle
veut depuis son espace, « Changer mon code PIN »).

Données seulement : les comptes encore marqués « PIN temporaire » sont
libérés, leur PIN actuel reste valable. Pas de changement de schéma.
Downgrade sans effet : on ne peut pas savoir quels comptes étaient marqués.

Revision ID: a9d4e1b7c2f6
Revises: f3b8d1c5a720
Create Date: 2026-11-04 18:00:00.000000

"""
from alembic import op


revision = 'a9d4e1b7c2f6'
down_revision = 'f3b8d1c5a720'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "UPDATE utilisateur SET doit_changer_mdp = 0, mdp_expire_le = NULL "
        "WHERE doit_changer_mdp = 1 OR mdp_expire_le IS NOT NULL"
    )


def downgrade():
    pass
