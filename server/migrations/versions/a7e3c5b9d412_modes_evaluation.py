"""modes d'évaluation : Lycée, Collège (CC + DS), Institut (CC + DS + Ev. Tr.)

- etablissement.mode_evaluation : mode choisi à la création, valeur par
  défaut des nouvelles années scolaires ;
- annee_scolaire.mode_evaluation : mode de l'année (définitif dès la
  première note saisie) ;
- note.composante : 'note' (Lycée), 'cc', 'ds' ou 'evtr' ; l'unicité porte
  désormais sur (inscription, matière-classe, séquence, composante).

Toutes les données existantes passent en mode Lycée / composante 'note' :
aucun changement de comportement pour les établissements actuels.

Revision ID: a7e3c5b9d412
Revises: f6c2a9d4b718
Create Date: 2026-11-16 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a7e3c5b9d412'
down_revision = 'f6c2a9d4b718'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('etablissement', sa.Column('mode_evaluation', sa.String(10), nullable=False,
                                             server_default='lycee'))
    op.add_column('annee_scolaire', sa.Column('mode_evaluation', sa.String(10), nullable=False,
                                              server_default='lycee'))
    op.add_column('note', sa.Column('composante', sa.String(5), nullable=False, server_default='note'))
    # Le nouvel index unique commence par inscription_id : créé AVANT de
    # retirer l'ancien, la clé étrangère note.inscription_id garde toujours
    # un index utilisable (exigence MySQL).
    # Mode batch : ALTER des contraintes aussi sous SQLite (MySQL : ALTER direct).
    # Nouvelle contrainte AVANT de retirer l'ancienne (MySQL : index utile aux clés étrangères).
    with op.batch_alter_table('note') as batch:
        batch.create_unique_constraint('uq_note_composante',
                                       ['inscription_id', 'matiere_classe_id', 'sequence_id', 'composante'])
        batch.drop_constraint('uq_note', type_='unique')


def downgrade():
    # Impossible de revenir en arrière si des notes CC/DS/Ev. Tr. existent :
    # plusieurs lignes par (inscription, matière-classe, séquence).
    with op.batch_alter_table('note') as batch:
        batch.create_unique_constraint('uq_note', ['inscription_id', 'matiere_classe_id', 'sequence_id'])
        batch.drop_constraint('uq_note_composante', type_='unique')
        batch.drop_column('composante')
    op.drop_column('annee_scolaire', 'mode_evaluation')
    op.drop_column('etablissement', 'mode_evaluation')
