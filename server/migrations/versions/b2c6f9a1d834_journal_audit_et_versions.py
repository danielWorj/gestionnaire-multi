"""Journal d'audit et versionnage des données synchronisées hors connexion

- journal_audit : qui a créé / modifié / supprimé quoi, quand (alimenté
  automatiquement, cf. services/audit_services.py). Pas de clé étrangère :
  l'historique survit à la suppression des lignes et des comptes.
- colonne `version` (1 par défaut, +1 à chaque modification) sur les tables
  que l'on peut modifier hors connexion : note, discipline, horaire, parent,
  eleve, inscription, paiement. Sert à détecter, à la synchronisation, une
  modification faite entre-temps par quelqu'un d'autre.

Les lignes existantes démarrent à version = 1 ; le journal démarre vide
(aucun historique n'existe pour ce qui a été fait avant cette migration).

Revision ID: b2c6f9a1d834
Revises: a9d4e1b7c2f6
Create Date: 2026-11-05 20:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'b2c6f9a1d834'
down_revision = 'a9d4e1b7c2f6'
branch_labels = None
depends_on = None

TABLES_VERSIONNEES = ('note', 'discipline', 'horaire', 'parent', 'eleve', 'inscription', 'paiement')


def upgrade():
    op.create_table(
        'journal_audit',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), primary_key=True, autoincrement=True),
        sa.Column('horodatage', sa.DateTime(), nullable=False),
        sa.Column('action', sa.String(length=12), nullable=False),
        sa.Column('table_nom', sa.String(length=64), nullable=False),
        sa.Column('ligne_id', sa.String(length=64), nullable=False),
        sa.Column('version_ligne', sa.Integer(), nullable=True),
        sa.Column('etablissement_id', sa.Integer(), nullable=True),
        sa.Column('auteur_type', sa.String(length=12), nullable=False),
        sa.Column('auteur_id', sa.Integer(), nullable=True),
        sa.Column('auteur_nom', sa.String(length=150), nullable=True),
        sa.Column('auteur_role', sa.String(length=50), nullable=True),
        sa.Column('adresse_ip', sa.String(length=45), nullable=True),
        sa.Column('saisi_hors_ligne_le', sa.DateTime(), nullable=True),
        sa.Column('changements', sa.JSON(), nullable=True),
    )
    op.create_index('ix_audit_ligne', 'journal_audit', ['table_nom', 'ligne_id'])
    op.create_index('ix_audit_etablissement_date', 'journal_audit', ['etablissement_id', 'horodatage'])
    op.create_index('ix_audit_auteur', 'journal_audit', ['auteur_type', 'auteur_id'])

    for table in TABLES_VERSIONNEES:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column('version', sa.Integer(), nullable=False, server_default='1'))


def downgrade():
    for table in TABLES_VERSIONNEES:
        with op.batch_alter_table(table) as batch:
            batch.drop_column('version')
    op.drop_index('ix_audit_auteur', table_name='journal_audit')
    op.drop_index('ix_audit_etablissement_date', table_name='journal_audit')
    op.drop_index('ix_audit_ligne', table_name='journal_audit')
    op.drop_table('journal_audit')
