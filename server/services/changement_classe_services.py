"""Changement de classe d'un élève en cours d'année (PUT /api/inscriptions/<id>
avec un nouveau classe_id).

Notes, dispenses et paiements sont rattachés à des objets PROPRES à la
classe (matière-classe, tranche de l'échéancier). Changer seulement
Inscription.classe_id les rendait orphelins : l'élève perdait ses notes
dans la nouvelle classe et apparaissait insolvable.

Règle (décision du 17/11/2026) :
  - même NIVEAU (6e A -> 6e B, cf. bulletin_services.cle_niveau) : les notes
    et dispenses passent sur la même matière de la nouvelle classe, les
    versements sur la tranche de même rang de son échéancier ; si une
    matière ou une tranche manque dans la nouvelle classe, le changement est
    refusé avec la liste de ce qui manque ;
  - niveau différent : refusé dès que l'élève a des notes ou des paiements
    sur l'année (sans données, le changement reste libre).
Les fiches de discipline, liées à l'inscription seule, suivent toujours.
Tout se fait dans la transaction du changement de classe (tout ou rien) ;
le journal d'audit trace chaque ligne déplacée.
"""
from extensions import db
from models.evaluation_models import Dispense, Note
from models.paiements_models import LignePaiement, Paiement, TrancheClasse
from models.pedagogie_models import MatiereClasse
from models.structure_models import Classe
from services.bulletin_services import cle_niveau, classe_label


def preparer_transfert(inscription, nouvelle_classe_id):
    """Rattache (sans committer) notes, dispenses et versements de
    l'inscription à la nouvelle classe. Retourne None, ou (erreur, 409)."""
    nouvelle = db.session.get(Classe, int(nouvelle_classe_id))
    ancienne = inscription.classe
    if nouvelle is None or ancienne is None or nouvelle.id == ancienne.id:
        return None

    notes = Note.query.filter_by(inscription_id=inscription.id).all()
    dispenses = Dispense.query.filter_by(inscription_id=inscription.id).all()
    lignes = (LignePaiement.query.join(Paiement, Paiement.id == LignePaiement.paiement_id)
              .filter(Paiement.inscription_id == inscription.id).all())
    if not notes and not dispenses and not lignes:
        return None

    if cle_niveau(ancienne) != cle_niveau(nouvelle):
        quoi = ' et '.join(x for x in (f"{len(notes)} note(s)" if notes else '',
                                        f"{len(lignes)} versement(s)" if lignes else '') if x)
        return {"erreur": (f"Changement de niveau impossible ({classe_label(ancienne)} → {classe_label(nouvelle)}) : "
                           f"l'élève a déjà {quoi} cette année. Un élève ne change de classe en gardant ses notes "
                           "et ses paiements qu'au sein du même niveau (ex. 6e A → 6e B). Vérifiez le niveau des "
                           "classes dans Configuration."),
                "code": "changement_niveau"}, 409

    # Matières : même matière dans la nouvelle classe.
    mc_cible = {mc.matiere_id: mc for mc in MatiereClasse.query.filter_by(classe_id=nouvelle.id).all()}
    mc_source = {mc.id: mc for mc in MatiereClasse.query.filter_by(classe_id=ancienne.id).all()}
    manquantes = sorted({mc_source[x.matiere_classe_id].matiere.libelle
                         for x in notes + dispenses
                         if x.matiere_classe_id in mc_source and mc_source[x.matiere_classe_id].matiere_id not in mc_cible})

    # Tranches : même rang dans l'échéancier de la nouvelle classe (même année).
    tranches_cible = {t.ordre: t for t in TrancheClasse.query.filter_by(
        classe_id=nouvelle.id, annee_scolaire_id=inscription.annee_scolaire_id).all()}
    tranches_absentes = sorted({l.tranche_classe.libelle for l in lignes
                                if l.tranche_classe.classe_id == ancienne.id
                                and l.tranche_classe.ordre not in tranches_cible})

    if manquantes or tranches_absentes:
        details = []
        if manquantes:
            details.append("matière(s) non affectée(s) à la nouvelle classe : " + ', '.join(manquantes))
        if tranches_absentes:
            details.append("tranche(s) absente(s) de son échéancier : " + ', '.join(tranches_absentes))
        return {"erreur": (f"Impossible de passer en {classe_label(nouvelle)} sans perdre de données — "
                           + ' ; '.join(details) + ". Complétez la nouvelle classe puis recommencez."),
                "code": "transfert_incomplet", "matieres": manquantes, "tranches": tranches_absentes}, 409

    for x in notes + dispenses:
        source = mc_source.get(x.matiere_classe_id)
        if source is not None:
            x.matiere_classe_id = mc_cible[source.matiere_id].id
    for l in lignes:
        if l.tranche_classe.classe_id == ancienne.id:
            l.tranche_classe_id = tranches_cible[l.tranche_classe.ordre].id
    return None
