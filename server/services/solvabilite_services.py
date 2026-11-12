"""État de solvabilité de l'établissement (rapport d'audit des frais exigibles).

Source UNIQUE des chiffres du rapport imprimé et de la vue « Paiements par
classe » : le navigateur ne recalcule plus rien (il ne disposait que des
données chargées à l'ouverture de la page, éventuellement périmées ou
incomplètes).

Situation reconstituée à une DATE D'ARRÊTÉ D (aujourd'hui par défaut) :
  - population : inscriptions de l'année faites au plus tard le jour D.
    Élèves EN COURS (Actif, Suspendu — un élève suspendu reste redevable)
    = périmètre de la solvabilité ; élèves SORTIS (Radié, Transféré) =
    créances résiduelles, présentées à part, hors taux.
    (C'est le statut d'inscription ACTUEL qui est utilisé : son historique
    n'est pas reconstitué.)
  - versements : paiements datés au plus tard le jour D et VALIDES ce
    jour-là. Un paiement annulé APRÈS D comptait encore à D : la date de son
    annulation est lue dans le journal d'audit.
  - tranche exigible à D : sans date limite, ou date limite < D (cf.
    paiements_services.tranche_exigible). Une tranche non échue n'est
    jamais « due ».
  - INSOLVABLE : impayé exigible > 0 ; SOLVABLE sinon ; SANS_ECHEANCIER :
    ni l'un ni l'autre, exclu des dénominateurs des taux.

Les montants versés sont lus sur les LignePaiement (ventilation par
tranche) ; une incohérence en-tête/lignes est signalée en anomalie.
"""
from datetime import date, datetime, timedelta

from extensions import db
from models.audit_models import JournalAudit
from models.authentification_models import Utilisateur
from models.inscription_models import Eleve, Inscription, Parent, STATUTS_INSCRIPTION_EN_COURS
from models.paiements_models import LignePaiement, Paiement, TrancheClasse
from models.structure_models import AnneeScolaire, Classe, Etablissement
from services.paiements_services import tranche_exigible

# (jours de retard min, max inclus, code, libellé)
TRANCHES_ANCIENNETE = (
    (1, 30, '1_30', '1 à 30 jours'),
    (31, 60, '31_60', '31 à 60 jours'),
    (61, 90, '61_90', '61 à 90 jours'),
    (91, None, 'plus_90', 'Plus de 90 jours'),
)

STATUT_LIBELLES = {'VALIDE': 'validé', 'ANNULE': 'annulé', 'REJETE': 'rejeté', 'REMBOURSE': 'remboursé'}


def _pct(numerateur, denominateur):
    """Pourcentage arrondi à 2 décimales ; None si le dénominateur est nul
    (« non applicable », à ne pas confondre avec 0 %)."""
    return round(numerateur * 100.0 / denominateur, 2) if denominateur else None


def _r2(x):
    return round(float(x or 0), 2)


def _libelle_classe(classe):
    cycle = classe.cycle.libelle if classe.cycle else None
    if cycle and classe.option:
        return f"{cycle} {classe.option}"
    return cycle or classe.option or f"Classe #{classe.id}"


def code_anciennete(jours):
    for mini, maxi, code, _ in TRANCHES_ANCIENNETE:
        if jours >= mini and (maxi is None or jours <= maxi):
            return code
    return TRANCHES_ANCIENNETE[0][2]


def _parse_date(valeur, nom):
    if valeur in (None, ''):
        return None, None
    if isinstance(valeur, date):
        return valeur, None
    try:
        return datetime.strptime(str(valeur)[:10], '%Y-%m-%d').date(), None
    except ValueError:
        return None, f"{nom} invalide (format attendu : AAAA-MM-JJ)"


def sorties_du_statut_valide(paiement_ids):
    """{paiement_id: JournalAudit} : première entrée d'audit où le statut du
    paiement a quitté VALIDE (annulation, rejet, remboursement)."""
    if not paiement_ids:
        return {}
    entrees = (
        JournalAudit.query
        .filter(JournalAudit.table_nom == 'paiement',
                JournalAudit.action == 'modification',
                JournalAudit.ligne_id.in_([str(i) for i in paiement_ids]))
        .order_by(JournalAudit.horodatage, JournalAudit.id)
        .all()
    )
    sorties = {}
    for e in entrees:
        changement = (e.changements or {}).get('statut')
        if (isinstance(changement, (list, tuple)) and len(changement) == 2
                and changement[0] == 'VALIDE' and changement[1] != 'VALIDE'):
            sorties.setdefault(int(e.ligne_id), e)
    return sorties


def get_rapport_solvabilite(etablissement_id, annee_scolaire_id=None, date_arrete=None,
                            date_debut=None, classe_id=None):
    """Rapport complet (cf. docstring du module). date_arrete / date_debut :
    'AAAA-MM-JJ' ou date. date_debut ne borne que la période des MOUVEMENTS
    de caisse (encaissements, annulations) ; la situation, elle, est
    toujours cumulée depuis le début de l'année. Renvoie (dict, status)."""
    aujourdhui = date.today()

    # ---- Paramètres -------------------------------------------------------
    date_arrete, erreur = _parse_date(date_arrete, 'date')
    if erreur:
        return {"erreur": erreur}, 400
    date_arrete = date_arrete or aujourdhui
    if date_arrete > aujourdhui:
        return {"erreur": "La date d'arrêté ne peut pas être dans le futur"}, 400

    date_debut, erreur = _parse_date(date_debut, 'du')
    if erreur:
        return {"erreur": erreur}, 400
    if date_debut and date_debut > date_arrete:
        return {"erreur": "Le début de la période doit précéder la date d'arrêté"}, 400

    if annee_scolaire_id:
        annee = db.session.get(AnneeScolaire, annee_scolaire_id)
        if not annee or annee.etablissement_id != etablissement_id:
            return {"erreur": "Année scolaire non trouvée"}, 404
    else:
        annee = AnneeScolaire.query.filter_by(etablissement_id=etablissement_id, active=True).first()
        if not annee:
            return {"erreur": "Aucune année scolaire active : précisez annee_scolaire_id"}, 400

    classes_q = Classe.query.filter(Classe.etablissement_id == etablissement_id)
    if classe_id:
        classes_q = classes_q.filter(Classe.id == classe_id)
    classes = classes_q.all()
    if classe_id and not classes:
        return {"erreur": "Classe non trouvée"}, 404
    classes_par_id = {c.id: c for c in classes}
    ids_classes = list(classes_par_id)

    # date_paiement et horodatage d'audit sont en UTC naïf.
    fin_arrete = datetime.combine(date_arrete + timedelta(days=1), datetime.min.time())
    debut_periode = datetime.combine(date_debut, datetime.min.time()) if date_debut else None

    # ---- Échéancier -------------------------------------------------------
    tranches_par_classe = {}
    if ids_classes:
        for t in (TrancheClasse.query
                  .filter(TrancheClasse.classe_id.in_(ids_classes),
                          TrancheClasse.annee_scolaire_id == annee.id)
                  .order_by(TrancheClasse.classe_id, TrancheClasse.ordre).all()):
            tranches_par_classe.setdefault(t.classe_id, []).append(t)

    # ---- Inscriptions, élèves, parents -----------------------------------
    inscriptions = []
    if ids_classes:
        inscriptions = (Inscription.query
                        .filter(Inscription.classe_id.in_(ids_classes),
                                Inscription.annee_scolaire_id == annee.id,
                                Inscription.date_inscription <= date_arrete)
                        .all())
    inscriptions_par_id = {i.id: i for i in inscriptions}
    eleves = ({e.id: e for e in Eleve.query.filter(Eleve.id.in_({i.eleve_id for i in inscriptions})).all()}
              if inscriptions else {})
    ids_parents = {e.parent_id for e in eleves.values() if e.parent_id}
    parents = {p.id: p for p in Parent.query.filter(Parent.id.in_(ids_parents)).all()} if ids_parents else {}

    # ---- Paiements de l'année (jusqu'à la date d'arrêté) ------------------
    paiements = []
    if inscriptions:
        paiements = (Paiement.query
                     .filter(Paiement.inscription_id.in_(list(inscriptions_par_id)),
                             Paiement.date_paiement < fin_arrete)
                     .all())
    sorties = sorties_du_statut_valide([p.id for p in paiements if p.statut != 'VALIDE'])

    def compte_a_l_arrete(p):
        if p.statut == 'VALIDE':
            return True
        sortie = sorties.get(p.id)
        return sortie is not None and sortie.horodatage >= fin_arrete

    paiements_comptes = [p for p in paiements if compte_a_l_arrete(p)]
    paiements_par_id = {p.id: p for p in paiements}
    lignes = (LignePaiement.query
              .filter(LignePaiement.paiement_id.in_([p.id for p in paiements_comptes])).all()
              if paiements_comptes else [])

    verse = {}           # {inscription_id: {tranche_id: montant}}
    sommes_lignes = {}   # {paiement_id: somme des lignes}
    for l in lignes:
        p = paiements_par_id[l.paiement_id]
        montant = float(l.montant_verse)
        sommes_lignes[p.id] = sommes_lignes.get(p.id, 0.0) + montant
        par_tranche = verse.setdefault(p.inscription_id, {})
        par_tranche[l.tranche_classe_id] = par_tranche.get(l.tranche_classe_id, 0.0) + montant

    def ident_eleve(insc):
        e = eleves.get(insc.eleve_id)
        return {
            "matricule": e.matricule if e else None,
            "nom": e.nom if e else None,
            "prenom": e.prenom if e else None,
            "classe": _libelle_classe(classes_par_id[insc.classe_id]),
        }

    anomalies = []
    for p in paiements_comptes:
        somme = round(sommes_lignes.get(p.id, 0.0), 2)
        if somme != round(float(p.montant_total), 2):
            anomalies.append({
                "type": "ventilation_incoherente",
                "message": (f"Reçu {p.numero_recu} : montant total {float(p.montant_total):,.0f} différent de la "
                            f"somme de ses lignes ({somme:,.0f})").replace(',', ' '),
                **ident_eleve(inscriptions_par_id[p.inscription_id]),
            })
    for p in paiements:
        if p.statut != 'VALIDE' and p.id not in sorties:
            anomalies.append({
                "type": "annulation_sans_trace",
                "message": (f"Reçu {p.numero_recu} ({STATUT_LIBELLES.get(p.statut, p.statut)}) : date de "
                            "l'annulation absente du journal d'audit — considéré comme déjà annulé à la date d'arrêté"),
                **ident_eleve(inscriptions_par_id[p.inscription_id]),
            })

    # ---- Situation par élève ---------------------------------------------
    def situation(insc):
        tr = tranches_par_classe.get(insc.classe_id, [])
        v = verse.get(insc.id, {})
        ids_tr = {t.id for t in tr}
        hors_echeancier = sum(m for tid, m in v.items() if tid not in ids_tr)
        attendu = exigible = verse_total = verse_exigible = 0.0
        en_retard = []
        for t in tr:
            montant = float(t.montant_attendu)
            paye = min(v.get(t.id, 0.0), montant)
            attendu += montant
            verse_total += paye
            if tranche_exigible(t.date_limite, date_arrete):
                exigible += montant
                verse_exigible += paye
                reste = round(montant - paye, 2)
                if reste > 0:
                    # Le retard court depuis la date limite, mais jamais
                    # avant l'inscription (élève inscrit après l'échéance,
                    # ou tranche sans date limite : due dès l'inscription).
                    depuis = max(d for d in (t.date_limite, insc.date_inscription) if d)
                    jours = max((date_arrete - depuis).days, 1)
                    en_retard.append({
                        "tranche_classe_id": t.id, "libelle": t.libelle,
                        "date_limite": t.date_limite.isoformat() if t.date_limite else None,
                        "reste_du": reste, "jours_retard": jours,
                        "anciennete": code_anciennete(jours),
                    })
        if round(hors_echeancier, 2) > 0:
            anomalies.append({
                "type": "versement_hors_echeancier",
                "message": (f"{hors_echeancier:,.0f} versés sur des tranches d'une autre classe (changement de "
                            "classe en cours d'année ?) : non imputés sur l'échéancier actuel").replace(',', ' '),
                **ident_eleve(insc),
            })
        impaye = round(exigible - verse_exigible, 2)
        if not tr:
            statut = 'SANS_ECHEANCIER'
        elif impaye > 0:
            statut = 'INSOLVABLE'
        else:
            statut = 'SOLVABLE'
        e = eleves.get(insc.eleve_id)
        parent = parents.get(e.parent_id) if e and e.parent_id else None
        return {
            "inscription_id": insc.id,
            "eleve_id": insc.eleve_id,
            **ident_eleve(insc),
            "sexe": e.sexe if e else None,
            "classe_id": insc.classe_id,
            "statut_inscription": insc.statut,
            "attendu": _r2(attendu),
            "exigible": _r2(exigible),
            "verse": _r2(verse_total),
            "verse_sur_exigible": _r2(verse_exigible),
            "impaye_exigible": impaye,
            "avance": _r2(verse_total - verse_exigible),
            "reste_annuel": _r2(attendu - verse_total),
            "solvabilite": statut,
            "jours_retard": max((r["jours_retard"] for r in en_retard), default=0),
            "tranches_en_retard": en_retard,
            "parent": ({"nom": f"{parent.nom} {parent.prenom}".strip(), "telephone": parent.telephone}
                       if parent else None),
        }

    def cle_nom(s):
        return ((s["nom"] or '').upper(), (s["prenom"] or '').upper())

    en_cours, sortis = [], []
    for insc in inscriptions:
        (en_cours if insc.statut in STATUTS_INSCRIPTION_EN_COURS else sortis).append(situation(insc))
    en_cours.sort(key=cle_nom)

    def agreger(situations):
        evaluables = [s for s in situations if s["solvabilite"] != 'SANS_ECHEANCIER']
        nb_insolvables = sum(1 for s in evaluables if s["solvabilite"] == 'INSOLVABLE')
        a = {
            "effectif": len(situations),
            "suspendus": sum(1 for s in situations if s["statut_inscription"] == 'Suspendu'),
            "sans_echeancier": len(situations) - len(evaluables),
            "effectif_evaluable": len(evaluables),
            "solvables": len(evaluables) - nb_insolvables,
            "insolvables": nb_insolvables,
        }
        for champ in ("attendu", "exigible", "verse", "verse_sur_exigible", "impaye_exigible", "avance", "reste_annuel"):
            a[champ] = _r2(sum(s[champ] for s in situations))
        a["pct_solvables"] = _pct(a["solvables"], a["effectif_evaluable"])
        a["pct_insolvables"] = _pct(a["insolvables"], a["effectif_evaluable"])
        a["taux_recouvrement_exigible"] = _pct(a["verse_sur_exigible"], a["exigible"])
        a["taux_recouvrement_annuel"] = _pct(a["verse"], a["attendu"])
        return a

    def anciennete(situations):
        """Élèves classés par leur retard le PLUS ancien ; montants ventilés
        selon l'ancienneté de CHAQUE tranche impayée."""
        lignes_a = {code: {"code": code, "libelle": lib, "nb_eleves": 0, "montant": 0.0}
                    for _, _, code, lib in TRANCHES_ANCIENNETE}
        for s in situations:
            if s["solvabilite"] != 'INSOLVABLE':
                continue
            lignes_a[code_anciennete(s["jours_retard"])]["nb_eleves"] += 1
            for r in s["tranches_en_retard"]:
                lignes_a[r["anciennete"]]["montant"] += r["reste_du"]
        return [{**l, "montant": _r2(l["montant"])} for l in lignes_a.values()]

    # ---- Par classe -------------------------------------------------------
    rapport_classes = []
    for c in classes:
        sit = [s for s in en_cours if s["classe_id"] == c.id]
        if not sit and not classe_id:
            continue
        detail_tranches = []
        for t in tranches_par_classe.get(c.id, []):
            montant = float(t.montant_attendu)
            payes = [min(verse.get(s["inscription_id"], {}).get(t.id, 0.0), montant) for s in sit]
            attendu_total = montant * len(sit)
            verse_total = sum(payes)
            detail_tranches.append({
                "tranche_classe_id": t.id, "libelle": t.libelle, "ordre": t.ordre,
                "date_limite": t.date_limite.isoformat() if t.date_limite else None,
                "echue": tranche_exigible(t.date_limite, date_arrete),
                "montant_unitaire": _r2(montant),
                "attendu_total": _r2(attendu_total),
                "verse_total": _r2(verse_total),
                "pct_paye": _pct(verse_total, attendu_total),
                "nb_soldes": sum(1 for x in payes if round(montant - x, 2) <= 0),
                "nb_non_soldes": sum(1 for x in payes if round(montant - x, 2) > 0),
            })
        rapport_classes.append({
            "classe_id": c.id, "classe": _libelle_classe(c),
            "a_echeancier": bool(tranches_par_classe.get(c.id)),
            **agreger(sit),
            "tranches": detail_tranches,
        })
    rapport_classes.sort(key=lambda c: c["classe"])

    # ---- Créances sur élèves sortis --------------------------------------
    creances_sortis = sorted((s for s in sortis if s["impaye_exigible"] > 0),
                             key=lambda s: (-s["impaye_exigible"], cle_nom(s)))

    # ---- Mouvements de caisse de la période ------------------------------
    def dans_periode(dt):
        return dt is not None and dt < fin_arrete and (debut_periode is None or dt >= debut_periode)

    ids_agents = {p.encaisse_par_id for p in paiements}
    agents = ({u.id: u.nom for u in Utilisateur.query.filter(Utilisateur.id.in_(ids_agents)).all()}
              if ids_agents else {})

    encaisses = [p for p in paiements_comptes if dans_periode(p.date_paiement)]
    par_mode, par_agent = {}, {}
    for p in encaisses:
        m = par_mode.setdefault(p.mode_paiement, {"mode": p.mode_paiement, "nb": 0, "montant": 0.0})
        m["nb"] += 1
        m["montant"] += float(p.montant_total)
        a = par_agent.setdefault(p.encaisse_par_id, {
            "agent": agents.get(p.encaisse_par_id) or f"Compte #{p.encaisse_par_id}", "nb": 0, "montant": 0.0})
        a["nb"] += 1
        a["montant"] += float(p.montant_total)

    annulations = []
    for p in paiements:
        if p.statut == 'VALIDE':
            continue
        sortie = sorties.get(p.id)
        quand = sortie.horodatage if sortie else None
        # Annulation postérieure à la date d'arrêté : hors période.
        if not dans_periode(quand if quand is not None else p.date_paiement):
            continue
        annulations.append({
            "numero_recu": p.numero_recu,
            "statut": p.statut,
            "montant": _r2(p.montant_total),
            "date_paiement": p.date_paiement.isoformat() + 'Z',
            "date_annulation": quand.isoformat() + 'Z' if quand else None,
            "motif": p.motif_annulation,
            "annule_par": sortie.auteur_nom if sortie else None,
            "encaisse_par": agents.get(p.encaisse_par_id),
            **ident_eleve(inscriptions_par_id[p.inscription_id]),
        })
    annulations.sort(key=lambda a: a["date_annulation"] or a["date_paiement"])

    etab = db.session.get(Etablissement, etablissement_id)
    genere_le = datetime.utcnow()
    insolvables = sorted((s for s in en_cours if s["solvabilite"] == 'INSOLVABLE'),
                         key=lambda s: (-s["impaye_exigible"], cle_nom(s)))
    return {
        "reference": f"SOLV-{etab.code if etab else etablissement_id}-{date_arrete:%Y%m%d}-{datetime.now():%H%M%S}",
        "genere_le": genere_le.isoformat(timespec='seconds') + 'Z',
        "date_arrete": date_arrete.isoformat(),
        "est_date_du_jour": date_arrete == aujourdhui,
        "annee_scolaire": {"id": annee.id, "libelle": annee.libelle},
        "classe_id": classe_id,
        "global": {**agreger(en_cours), "nb_classes": len(rapport_classes)},
        "anciennete": anciennete(en_cours),
        "classes": rapport_classes,
        "eleves": en_cours,
        "insolvables": insolvables,
        "creances_sortis": {
            "nb": len(creances_sortis),
            "montant": _r2(sum(s["impaye_exigible"] for s in creances_sortis)),
            "eleves": creances_sortis,
        },
        "mouvements": {
            "du": date_debut.isoformat() if date_debut else None,
            "au": date_arrete.isoformat(),
            "nb_encaissements": len(encaisses),
            "montant_encaisse": _r2(sum(float(p.montant_total) for p in encaisses)),
            "par_mode": sorted(({**m, "montant": _r2(m["montant"])} for m in par_mode.values()),
                               key=lambda m: -m["montant"]),
            "par_agent": sorted(({**a, "montant": _r2(a["montant"])} for a in par_agent.values()),
                                key=lambda a: -a["montant"]),
            "nb_annulations": len(annulations),
            "montant_annule": _r2(sum(a["montant"] for a in annulations)),
            "annulations": annulations,
        },
        "anomalies": anomalies,
    }, 200
