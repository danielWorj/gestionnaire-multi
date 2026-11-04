"""Modèles Excel vierges proposés au téléchargement par les assistants
d'import (enseignants, classes, matières)."""

import io

import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation


def modele_xlsx(titre, entetes, exemples, largeurs=(), listes=None, aide=()):
    """listes : {lettre de colonne: [valeurs autorisées]} (liste déroulante)."""
    classeur = openpyxl.Workbook()
    feuille = classeur.active
    feuille.title = titre[:31]
    feuille.append(entetes)
    for ligne in exemples:
        feuille.append(ligne)
    for cellule in feuille[1]:
        cellule.font = Font(bold=True, color='FFFFFF')
        cellule.fill = PatternFill('solid', fgColor='696CFF')
    for i, largeur in enumerate(largeurs, start=1):
        feuille.column_dimensions[get_column_letter(i)].width = largeur
    for colonne, valeurs in (listes or {}).items():
        validation = DataValidation(type='list', formula1='"' + ','.join(valeurs) + '"', allow_blank=True)
        feuille.add_data_validation(validation)
        validation.add(f'{colonne}2:{colonne}2000')
    feuille.freeze_panes = 'A2'

    feuille_aide = classeur.create_sheet('Aide')
    feuille_aide.append(['Comment remplir ce modèle'])
    feuille_aide.append([''])
    for ligne in aide:
        feuille_aide.append([ligne])
    feuille_aide['A1'].font = Font(bold=True, size=13)
    feuille_aide.column_dimensions['A'].width = 120

    flux = io.BytesIO()
    classeur.save(flux)
    flux.seek(0)
    return flux
