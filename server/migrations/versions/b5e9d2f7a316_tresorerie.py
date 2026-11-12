"""trésorerie : catégories (fonds), comptes, mouvements, ventilation des
dépenses sur les fonds, et rattachement des tranches à un fonds

- categorie_tresorerie : catégories d'entrée (= fonds) et de sortie ;
- compte_tresorerie : caisse, banque, mobile money ;
- mouvement_tresorerie : entrées hors scolarité, dépenses, transferts ;
- ventilation_depense : part d'une dépense prise sur chaque fonds ;
- tranche_classe.categorie_entree_id : fonds alimenté par la tranche
  (NULL = catégorie par défaut « Scolarité », créée à la première ouverture
  du module).

Revision ID: b5e9d2f7a316
Revises: a3f7c9e2b814
Create Date: 2026-11-12 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b5e9d2f7a316'
down_revision = 'a3f7c9e2b814'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'categorie_tresorerie',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('etablissement_id', sa.Integer(), nullable=False),
        sa.Column('type', sa.String(length=10), nullable=False),
        sa.Column('libelle', sa.String(length=100), nullable=False),
        sa.Column('par_defaut', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('actif', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.CheckConstraint("type IN ('ENTREE','SORTIE')", name='ck_categorie_tresorerie_type'),
        sa.ForeignKeyConstraint(['etablissement_id'], ['etablissement.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('etablissement_id', 'type', 'libelle', name='uq_categorie_tresorerie'),
    )

    op.create_table(
        'compte_tresorerie',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('etablissement_id', sa.Integer(), nullable=False),
        sa.Column('type', sa.String(length=15), nullable=False),
        sa.Column('libelle', sa.String(length=100), nullable=False),
        sa.Column('par_defaut', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('actif', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.CheckConstraint("type IN ('CAISSE','BANQUE','MOBILE_MONEY')", name='ck_compte_tresorerie_type'),
        sa.ForeignKeyConstraint(['etablissement_id'], ['etablissement.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('etablissement_id', 'libelle', name='uq_compte_tresorerie'),
    )

    op.create_table(
        'mouvement_tresorerie',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('etablissement_id', sa.Integer(), nullable=False),
        sa.Column('sens', sa.String(length=10), nullable=False),
        sa.Column('date_operation', sa.Date(), nullable=False),
        sa.Column('montant', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('libelle', sa.String(length=255), nullable=False),
        sa.Column('categorie_id', sa.Integer(), nullable=True),
        sa.Column('compte_id', sa.Integer(), nullable=False),
        sa.Column('compte_destination_id', sa.Integer(), nullable=True),
        sa.Column('tiers', sa.String(length=150), nullable=True),
        sa.Column('reference', sa.String(length=100), nullable=True),
        sa.Column('statut', sa.String(length=10), nullable=False, server_default='VALIDE'),
        sa.Column('motif_annulation', sa.String(length=255), nullable=True),
        sa.Column('saisi_par_id', sa.Integer(), nullable=False),
        sa.Column('cree_le', sa.DateTime(), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
        sa.CheckConstraint('montant > 0', name='ck_mouvement_montant_positif'),
        sa.CheckConstraint("sens IN ('ENTREE','SORTIE','TRANSFERT')", name='ck_mouvement_sens'),
        sa.CheckConstraint("statut IN ('VALIDE','ANNULE')", name='ck_mouvement_statut'),
        sa.CheckConstraint("statut <> 'ANNULE' OR motif_annulation IS NOT NULL", name='ck_mouvement_annulation'),
        sa.CheckConstraint(
            "(sens = 'TRANSFERT' AND categorie_id IS NULL AND compte_destination_id IS NOT NULL) OR "
            "(sens <> 'TRANSFERT' AND categorie_id IS NOT NULL AND compte_destination_id IS NULL)",
            name='ck_mouvement_coherence'),
        sa.ForeignKeyConstraint(['etablissement_id'], ['etablissement.id']),
        sa.ForeignKeyConstraint(['categorie_id'], ['categorie_tresorerie.id']),
        sa.ForeignKeyConstraint(['compte_id'], ['compte_tresorerie.id']),
        sa.ForeignKeyConstraint(['compte_destination_id'], ['compte_tresorerie.id']),
        sa.ForeignKeyConstraint(['saisi_par_id'], ['utilisateur.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_mouvement_etab_date', 'mouvement_tresorerie', ['etablissement_id', 'date_operation'])

    op.create_table(
        'ventilation_depense',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('mouvement_id', sa.Integer(), nullable=False),
        sa.Column('categorie_entree_id', sa.Integer(), nullable=False),
        sa.Column('montant', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.CheckConstraint('montant > 0', name='ck_ventilation_montant_positif'),
        sa.ForeignKeyConstraint(['mouvement_id'], ['mouvement_tresorerie.id']),
        sa.ForeignKeyConstraint(['categorie_entree_id'], ['categorie_tresorerie.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('mouvement_id', 'categorie_entree_id', name='uq_ventilation_fonds'),
    )

    with op.batch_alter_table('tranche_classe', schema=None) as batch_op:
        batch_op.add_column(sa.Column('categorie_entree_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key('fk_tranche_categorie_entree', 'categorie_tresorerie',
                                    ['categorie_entree_id'], ['id'])


def downgrade():
    with op.batch_alter_table('tranche_classe', schema=None) as batch_op:
        batch_op.drop_constraint('fk_tranche_categorie_entree', type_='foreignkey')
        batch_op.drop_column('categorie_entree_id')

    op.drop_table('ventilation_depense')
    op.drop_index('ix_mouvement_etab_date', table_name='mouvement_tresorerie')
    op.drop_table('mouvement_tresorerie')
    op.drop_table('compte_tresorerie')
    op.drop_table('categorie_tresorerie')
