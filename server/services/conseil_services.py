"""Document du conseil de classe (séquentiel, trimestriel, annuel).

Périmètres :
  - classe          : une classe (Censeur : ses classes ; Admin / SuperAdmin) ;
  - niveau          : toutes les classes d'un niveau (6e A, 6e B…) ;
  - cycle           : toutes les classes d'un cycle ;
  - etablissement   : tout l'établissement en une fois.
Les trois derniers sont réservés à l'Admin et au SuperAdmin.

Tous les chiffres viennent de bulletin_services.construire_bulletins (même
calcul que les bulletins imprimés : moyennes tronquées, rangs, mentions,
dispenses) : le conseil ne recalcule rien de son côté.

Contenu, pour chaque classe :
  - effectif, élèves classés, moyenne de la classe, plus forte / plus faible,
    taux de réussite (moyenne ≥ 10), par sexe ;
  - répartition des moyennes par tranche ;
  - résultats par matière (moyenne de la classe, taux ≥ 10, min / max) ;
  - distinctions et sanctions de travail (félicitations, encouragements,
    tableau d'honneur, avertissements, blâmes) ;
  - discipline (absences, retards, exclusions) et élèves les plus absents ;
  - élèves en difficulté (moyenne < 10) ;
  - en fin d'année : proposition de décision par élève (à valider par le
    conseil), le classement complet sinon.
Pour un niveau, un cycle ou l'établissement : un tableau comparatif des
classes et la synthèse globale, puis le détail de chaque classe.
"""
from collections import defaultdict

from extensions import db
from models.structure_models import AnneeScolaire, Classe, Cycle
from services.bulletin_services import (
    BulletinErreur, _t2, classe_label, cle_niveau, construire_bulletins, libelle_niveau_deduit,
)

PORTEES = ('classe', 'niveau', 'cycle', 'etablissement')

REPARTITION = [(16, None, '16 et plus'), (14, 16, '14 à 16'), (12, 14, '12 à 14'), (10, 12, '10 à 12'),
               (8, 10, '8 à 10'), (0, 8, 'Moins de 8')]


class ConseilErreur(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def _nom(e):
    return f"{(e.get('nom') or '').upper()} {(e.get('prenom') or '').title()}".strip()


def _taux(n, total):
    return round(100 * n / total, 1) if total else None


def _cle_niveau_texte(classe):
    """Identifiant de niveau transmis au client : « niveau:<id> » pour un
    niveau enregistré, « auto:<libellé> » pour un niveau déduit du nom."""
    if classe.niveau_id:
        return f"niveau:{classe.niveau_id}"
    return f"auto:{libelle_niveau_deduit(classe)}"


def _libelle_niveau(classe):
    return classe.niveau.libelle if classe.niveau_id and classe.niveau else libelle_niveau_deduit(classe)


def perimetres(etablissement_id, classe_ids_restriction=None):
    """Classes, niveaux et cycles proposés au choix (Censeur : ses classes)."""
    classes = Classe.query.filter_by(etablissement_id=etablissement_id).all()
    if classe_ids_restriction is not None:
        classes = [c for c in classes if c.id in classe_ids_restriction]
    classes.sort(key=lambda c: classe_label(c).lower())
    niveaux, cycles = {}, {}
    for c in classes:
        cle = _cle_niveau_texte(c)
        niveaux.setdefault(cle, {"cle": cle, "libelle": _libelle_niveau(c), "classe_ids": []})["classe_ids"].append(c.id)
        cycles.setdefault(c.cycle_id, {"id": c.cycle_id, "libelle": c.cycle.libelle if c.cycle else '—',
                                       "classe_ids": []})["classe_ids"].append(c.id)
    return {
        "classes": [{"id": c.id, "label": classe_label(c)} for c in classes],
        "niveaux": sorted(niveaux.values(), key=lambda n: n["libelle"].lower()),
        "cycles": sorted(cycles.values(), key=lambda c: c["libelle"].lower()),
    }


def _classes_du_perimetre(etablissement_id, portee, cible, classe_ids_restriction):
    if portee not in PORTEES:
        raise ConseilErreur("Périmètre invalide (classe, niveau, cycle ou etablissement)")
    if classe_ids_restriction is not None and portee != 'classe':
        raise ConseilErreur("Vous ne pouvez générer que le conseil de vos classes", 403)
    classes = Classe.query.filter_by(etablissement_id=etablissement_id).all()
    if portee == 'classe':
        classes = [c for c in classes if str(c.id) == str(cible)]
        if not classes:
            raise ConseilErreur("Classe introuvable", 404)
        if classe_ids_restriction is not None and classes[0].id not in classe_ids_restriction:
            raise ConseilErreur("Cette classe ne vous est pas assignée", 403)
    elif portee == 'niveau':
        classes = [c for c in classes if _cle_niveau_texte(c) == cible]
        if not classes:
            raise ConseilErreur("Niveau introuvable", 404)
    elif portee == 'cycle':
        classes = [c for c in classes if str(c.cycle_id) == str(cible)]
        if not classes:
            raise ConseilErreur("Cycle introuvable ou sans classe", 404)
    if not classes:
        raise ConseilErreur("Aucune classe dans cet établissement", 404)
    return sorted(classes, key=lambda c: (cle_niveau(c), classe_label(c).lower()))


def _synthese_classe(data, type_periode):
    """Indicateurs d'une classe à partir des bulletins calculés."""
    bulletins = data["bulletins"]
    classes = [b for b in bulletins if b["moyenne"] is not None]
    moyennes = [b["moyenne"] for b in classes]
    par_sexe = {}
    for sexe, libelle in (('F', 'Filles'), ('M', 'Garçons')):
        groupe = [b for b in bulletins if b["eleve"]["sexe"] == sexe]
        notes = [b["moyenne"] for b in groupe if b["moyenne"] is not None]
        par_sexe[sexe] = {"libelle": libelle, "effectif": len(groupe), "classes": len(notes),
                          "reussite": sum(1 for m in notes if m >= 10),
                          "taux": _taux(sum(1 for m in notes if m >= 10), len(notes)),
                          "moyenne": _t2(sum(notes) / len(notes)) if notes else None}
    repartition = [{"libelle": lib, "nombre": sum(1 for m in moyennes if m >= mini and (maxi is None or m < maxi))}
                   for mini, maxi, lib in REPARTITION]

    # Résultats par matière (une ligne par matière de la classe).
    matieres = []
    if bulletins:
        for g_index, groupe in enumerate(bulletins[0]["groupes"]):
            for l_index, ligne in enumerate(groupe["lignes"]):
                valeurs = [b["groupes"][g_index]["lignes"][l_index]["moyenne"] for b in bulletins]
                valeurs = [v for v in valeurs if v is not None]
                matieres.append({
                    "matiere": ligne["matiere"], "enseignant": ligne["enseignant"], "coefficient": ligne["coefficient"],
                    "moyenne": ligne["moyenne_classe"], "note_min": ligne["note_min"], "note_max": ligne["note_max"],
                    "classes": len(valeurs), "reussite": sum(1 for v in valeurs if v >= 10),
                    "taux": _taux(sum(1 for v in valeurs if v >= 10), len(valeurs)),
                })
        # De la matière la mieux comprise à la moins comprise : taux de
        # réussite décroissant, puis moyenne de classe ; matières sans élève
        # classé en fin de liste.
        matieres.sort(key=lambda m: (m["taux"] is None, -(m["taux"] or 0), -(m["moyenne"] or 0),
                                     (m["matiere"] or '').lower()))

    def liste(predicat):
        return sorted(({"nom": _nom(b["eleve"]), "moyenne": b["moyenne"], "rang": b["rang"]}
                       for b in classes if predicat(b)), key=lambda x: (x["rang"] or 10**6, x["nom"]))

    t = lambda b: b["travail"]  # noqa: E731
    distinctions = [
        {"libelle": "Félicitations (≥ 16)", "eleves": liste(lambda b: t(b)["felicitations"])},
        {"libelle": "Encouragements (14 à 16)", "eleves": liste(lambda b: t(b)["encouragements"])},
        {"libelle": "Tableau d'honneur (≥ 12)", "eleves": liste(lambda b: t(b)["tableau_honneur"])},
    ]
    sanctions = [
        {"libelle": "Avertissement travail (6 à 8)", "eleves": liste(lambda b: t(b)["avertissement"])},
        {"libelle": "Blâme travail (< 6)", "eleves": liste(lambda b: t(b)["blame"])},
    ]

    totaux = defaultdict(int)
    absents = []
    for b in bulletins:
        for cle, valeur in b["discipline_totaux"].items():
            totaux[cle] += valeur or 0
        heures = (b["discipline_totaux"].get("absences_non_justifiees") or 0)
        if heures or b["discipline_totaux"].get("exclusions"):
            absents.append({"nom": _nom(b["eleve"]), "non_justifiees": heures,
                            "justifiees": b["discipline_totaux"].get("absences_justifiees") or 0,
                            "retards": b["discipline_totaux"].get("retards") or 0,
                            "exclusions": b["discipline_totaux"].get("exclusions") or 0})
    absents.sort(key=lambda x: (-x["non_justifiees"], -x["exclusions"], x["nom"]))

    difficulte = sorted(({"nom": _nom(b["eleve"]), "moyenne": b["moyenne"], "rang": b["rang"],
                          "matieres_faibles": [l["matiere"] for g in b["groupes"] for l in g["lignes"]
                                               if l["moyenne"] is not None and l["moyenne"] < 10]}
                         for b in classes if b["moyenne"] < 10), key=lambda x: x["moyenne"])

    classement = sorted(({"numero": b["eleve"]["numero"], "nom": _nom(b["eleve"]), "sexe": b["eleve"]["sexe"],
                          "statut": b["eleve"]["statut"], "moyenne": b["moyenne"], "rang": b["rang"],
                          "mention": b["mention"], "sanction": b["sanction"],
                          "decision": (None if type_periode != 'annuel' or b["moyenne"] is None
                                       else "Admis(e)" if b["moyenne"] >= 10 else "Redouble (à statuer)")}
                         for b in bulletins), key=lambda x: (x["rang"] is None, x["rang"] or 0, x["nom"]))

    stats = data["statistiques"]
    return {
        "classe": data["classe"], "titulaire": data["titulaire"], "effectif": data["effectif"],
        "nb_classes": len(classes), "nb_non_classes": data["effectif"] - len(classes),
        "moyenne": stats["moyenne_classe"], "moyenne_min": _t2(stats["moyenne_min"]),
        "moyenne_max": _t2(stats["moyenne_max"]), "nb_sup_10": stats["nb_sup_10"],
        "taux_reussite": _taux(stats["nb_sup_10"], len(classes)),
        "par_sexe": par_sexe, "repartition": repartition, "matieres": matieres,
        "distinctions": distinctions, "sanctions": sanctions,
        "discipline": dict(totaux), "absents": absents[:10], "difficulte": difficulte,
        "classement": classement,
    }


def construire_conseil(etablissement, annee_id, periode, portee, cible=None, classe_ids_restriction=None):
    annee = AnneeScolaire.query.filter_by(id=annee_id, etablissement_id=etablissement.id).first() if annee_id else None
    if not annee:
        raise ConseilErreur("Année scolaire introuvable", 404)
    classes = _classes_du_perimetre(etablissement.id, portee, cible, classe_ids_restriction)

    sections, periode_info = [], None
    for classe in classes:
        try:
            data = construire_bulletins(etablissement, classe.id, annee.id, periode)
        except BulletinErreur as err:
            raise ConseilErreur(err.message, err.status)
        periode_info = data["periode"]
        synthese = _synthese_classe(data, data["periode"]["type"])
        synthese["niveau"] = _libelle_niveau(classe)
        synthese["cycle"] = classe.cycle.libelle if classe.cycle else None
        sections.append(synthese)

    # Synthèse globale (niveau, cycle, établissement).
    effectif = sum(s["effectif"] for s in sections)
    classes_eleves = sum(s["nb_classes"] for s in sections)
    reussite = sum(s["nb_sup_10"] for s in sections)
    toutes = [c["moyenne"] for s in sections for c in s["classement"] if c["moyenne"] is not None]
    globale = {
        "nb_classes_scolaires": len(sections), "effectif": effectif, "nb_classes": classes_eleves,
        "nb_sup_10": reussite, "taux_reussite": _taux(reussite, classes_eleves),
        "moyenne": _t2(sum(toutes) / len(toutes)) if toutes else None,
        "moyenne_min": min(toutes) if toutes else None, "moyenne_max": max(toutes) if toutes else None,
        "repartition": [{"libelle": lib, "nombre": sum(1 for m in toutes if m >= mini and (maxi is None or m < maxi))}
                        for mini, maxi, lib in REPARTITION],
        "meilleurs": sorted(({"nom": c["nom"], "classe": s["classe"]["label"], "moyenne": c["moyenne"]}
                             for s in sections for c in s["classement"] if c["moyenne"] is not None),
                            key=lambda x: -x["moyenne"])[:10],
    }
    # Classement des classes (taux de réussite puis moyenne).
    comparatif = sorted(({"classe": s["classe"]["label"], "niveau": s["niveau"], "effectif": s["effectif"],
                          "nb_classes": s["nb_classes"], "moyenne": s["moyenne"], "taux_reussite": s["taux_reussite"],
                          "moyenne_max": s["moyenne_max"], "moyenne_min": s["moyenne_min"],
                          "titulaire": s["titulaire"]} for s in sections),
                        key=lambda x: (-(x["taux_reussite"] or -1), -(x["moyenne"] or -1)))

    if portee == 'classe':
        intitule = sections[0]["classe"]["label"]
    elif portee == 'niveau':
        intitule = f"Niveau {sections[0]['niveau']}"
    elif portee == 'cycle':
        intitule = f"Cycle {sections[0]['cycle'] or ''}".strip()
    else:
        intitule = "Tout l'établissement"

    etab = etablissement.to_dict()
    return {
        "etablissement": etab,
        "annee": {"id": annee.id, "libelle": annee.libelle},
        "periode": periode_info,
        "portee": portee, "cible": cible, "intitule": intitule,
        "globale": globale, "comparatif": comparatif, "classes": sections,
    }
