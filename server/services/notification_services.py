"""Notifications dans l'application (cloche de la barre du haut).

Pas d'envoi SMS / WhatsApp / e-mail : les notifications sont calculées à
partir des données de l'établissement et affichées dans l'espace de chacun.
Liste volontairement COURTE et FIXE (aucun réglage à faire par
l'utilisateur) :

  Parent      — échéance de paiement : 7 jours avant, le jour même, puis
                en retard (bulletin suspendu) ; seulement si un reste est dû.
  Enseignant  — fin de séquence : rappel 7 jours avant (avec l'avancement de
                sa saisie), puis 3 jours et 2 jours avant tant que sa saisie
                est incomplète.
  Admin       — récapitulatif hebdomadaire de l'avancement de la saisie
                (par classe, enseignants en retard).

Génération (generer_notifications) : idempotente — chaque événement a une
clé et uq_notification interdit de le notifier deux fois. Les échéances sont
des FENÊTRES (ex. « entre 7 et 4 jours avant ») et non des jours exacts :
si personne ne se connecte le jour J-7, l'alerte part au premier passage
suivant. Seule l'alerte la plus urgente d'une échéance est créée à un
passage donné (pas de rafale « J-7 + J-2 » le même jour).

Déclenchement : à l'affichage des notifications, au plus toutes les 15
minutes par établissement (assurer_generation, sans tâche planifiée à
installer), et
par la commande `flask notifications` pour qui veut la planifier (cron).
"""
from datetime import date, datetime, timedelta

from sqlalchemy.exc import IntegrityError

from extensions import db
from models.authentification_models import Role, Utilisateur
from models.inscription_models import Inscription, Parent, STATUTS_INSCRIPTION_EN_COURS
from models.notification_models import Notification
from models.pedagogie_models import Enseignant, Matiere, MatiereClasse
from models.structure_models import Classe, Etablissement, annee_active, effectifs_classes, sequence_courante
from services.bulletin_services import classe_label, sequences_annee
from services.espace_parent_services import situations_paiement
from services.evaluation_services import notes_saisies_par_mc

# Notifications lues conservées ce nombre de jours, puis supprimées.
CONSERVATION_LUES = timedelta(days=90)
LIMITE_LISTE = 50
DETAIL_MAX = 4  # éléments cités dans un message avant « et N autres »


def _fcfa(montant):
    return f"{montant:,.0f}".replace(',', ' ') + ' FCFA'


def _date_fr(d):
    return d.strftime('%d/%m/%Y')


def _jours(n):
    return f"{n} jour{'s' if n > 1 else ''}"


def _enumeration(elements):
    elements = list(elements)
    texte = ', '.join(elements[:DETAIL_MAX])
    if len(elements) > DETAIL_MAX:
        texte += f" et {len(elements) - DETAIL_MAX} autre(s)"
    return texte


def _pct(n, total):
    return round(n * 100 / total) if total else 0


def _comptes_actifs(etablissement_id, role, ids=None):
    """{utilisateur_id: Utilisateur} des comptes actifs de l'établissement
    qui ont ce rôle (restreints à ids si fourni)."""
    query = Utilisateur.query.filter(
        Utilisateur.etablissement_id == etablissement_id,
        Utilisateur.actif.is_(True),
        Utilisateur.roles.any(Role.libelle == role),
    )
    if ids is not None:
        if not ids:
            return {}
        query = query.filter(Utilisateur.id.in_(list(ids)))
    return {u.id: u for u in query.all()}


# ---------------------------------------------------------------------------
# Règles
# ---------------------------------------------------------------------------

def _paiements_parents(etablissement_id, annee, aujourdhui):
    parents = Parent.query.filter(Parent.etablissement_id == etablissement_id,
                                  Parent.utilisateur_id.isnot(None)).all()
    comptes = _comptes_actifs(etablissement_id, 'Parent', {p.utilisateur_id for p in parents})
    parents = [p for p in parents if p.utilisateur_id in comptes]
    if not parents:
        return []

    parent_par_eleve = {e.id: p for p in parents for e in p.enfants}
    inscriptions = (Inscription.query
                    .filter(Inscription.eleve_id.in_(list(parent_par_eleve)),
                            Inscription.annee_scolaire_id == annee.id,
                            Inscription.statut.in_(STATUTS_INSCRIPTION_EN_COURS))
                    .all()) if parent_par_eleve else []
    situations = situations_paiement(inscriptions, aujourdhui)

    candidates = []
    for insc in inscriptions:
        parent = parent_par_eleve[insc.eleve_id]
        prenom = insc.eleve.prenom or insc.eleve.nom
        for t in situations[insc.id]["tranches"]:
            if t["reste_du"] <= 0:
                continue
            base = dict(utilisateur_id=parent.utilisateur_id, role='Parent', lien='/parent/paiements')
            limite = date.fromisoformat(t["date_limite"]) if t["date_limite"] else None
            if t["en_retard"]:
                depuis = f"échue depuis le {_date_fr(limite)}" if limite else "due depuis l'inscription"
                suite = ("" if insc.bulletin_debloque else
                         " Le bulletin est suspendu dans votre espace jusqu'au règlement.")
                candidates.append(dict(
                    base, type='retard_paiement', niveau='urgent',
                    cle=f"paiement|{insc.id}|{t['tranche_classe_id']}|retard",
                    titre=f"Frais en retard — {prenom}",
                    message=f"{prenom} : la tranche « {t['libelle']} » est {depuis}. "
                            f"Reste à payer : {_fcfa(t['reste_du'])}.{suite}"))
                continue
            if limite is None:
                continue
            jours = (limite - aujourdhui).days
            if jours == 0:
                palier, niveau, quand = 'J0', 'alerte', "aujourd'hui (dernier jour)"
            elif 0 < jours <= 7:
                palier, niveau, quand = 'J7', 'info', f"avant le {_date_fr(limite)} (dans {_jours(jours)})"
            else:
                continue
            candidates.append(dict(
                base, type='echeance_paiement', niveau=niveau,
                cle=f"paiement|{insc.id}|{t['tranche_classe_id']}|{palier}",
                titre=f"Échéance de paiement — {prenom}",
                message=f"{prenom} : la tranche « {t['libelle']} » est à régler {quand}. "
                        f"Reste à payer : {_fcfa(t['reste_du'])}."))
    return candidates


def _avancement_par_mc(etablissement_id, annee, sequence, liens):
    """{matiere_classe_id: (saisies, attendues)} : attendues = effectif en
    cours de la classe sur l'année (même règle que les espaces de saisie)."""
    classe_ids = {mc.classe_id for mc in liens}
    effectifs = effectifs_classes(etablissement_id, classe_ids, annee.id) if classe_ids else {}
    saisies = notes_saisies_par_mc([mc.id for mc in liens], sequence, annee)
    return {mc.id: (min(saisies.get(mc.id, 0), effectifs.get(mc.classe_id, 0)), effectifs.get(mc.classe_id, 0))
            for mc in liens}


def _liens_etablissement(etablissement_id):
    liens = (MatiereClasse.query.join(Classe, Classe.id == MatiereClasse.classe_id)
             .filter(Classe.etablissement_id == etablissement_id).all())
    classes = {c.id: c for c in Classe.query.filter(Classe.id.in_({mc.classe_id for mc in liens})).all()} if liens else {}
    matieres = {m.id: m for m in Matiere.query.filter(Matiere.id.in_({mc.matiere_id for mc in liens})).all()} if liens else {}
    return liens, classes, matieres


def _sequences_enseignants(etablissement_id, annee, aujourdhui):
    a_venir = []
    for s in sequences_annee(annee.id):
        if s.date_fin is None:
            continue
        jours = (s.date_fin - aujourdhui).days
        if 3 < jours <= 7:
            a_venir.append((s, jours, 'J7'))
        elif jours == 3:
            a_venir.append((s, jours, 'J3'))
        elif 0 <= jours <= 2:
            a_venir.append((s, jours, 'J2'))
    if not a_venir:
        return []

    enseignants = Enseignant.query.filter(Enseignant.etablissement_id == etablissement_id,
                                          Enseignant.utilisateur_id.isnot(None)).all()
    comptes = _comptes_actifs(etablissement_id, 'Enseignant', {e.utilisateur_id for e in enseignants})
    enseignants = {e.id: e for e in enseignants if e.utilisateur_id in comptes}
    liens, classes, matieres = _liens_etablissement(etablissement_id)
    liens = [mc for mc in liens if mc.enseignant_id in enseignants]
    if not liens:
        return []

    candidates = []
    for sequence, jours, palier in a_venir:
        avancement = _avancement_par_mc(etablissement_id, annee, sequence, liens)
        for ens_id, enseignant in enseignants.items():
            siens = [mc for mc in liens if mc.enseignant_id == ens_id]
            saisies = sum(avancement[mc.id][0] for mc in siens)
            attendues = sum(avancement[mc.id][1] for mc in siens)
            if not attendues:
                continue
            manquantes = attendues - saisies
            quand = "aujourd'hui" if jours == 0 else f"le {_date_fr(sequence.date_fin)} (dans {_jours(jours)})"
            base = dict(utilisateur_id=enseignant.utilisateur_id, role='Enseignant', lien='/enseignant/notes',
                        cle=f"sequence|{sequence.id}|{palier}")
            if palier == 'J7':
                etat = ("Toutes vos notes sont saisies." if not manquantes else
                        f"Votre saisie : {saisies}/{attendues} notes ({_pct(saisies, attendues)} %).")
                candidates.append(dict(base, type='fin_sequence', niveau='info',
                                       titre=f"Fin de la séquence {sequence.libelle}",
                                       message=f"La séquence {sequence.libelle} se termine {quand}. {etat}"))
            elif manquantes:
                detail = _enumeration(
                    f"{matieres[mc.matiere_id].libelle if mc.matiere_id in matieres else 'Matière'} "
                    f"{classe_label(classes[mc.classe_id])} ({avancement[mc.id][1] - avancement[mc.id][0]})"
                    for mc in sorted(siens, key=lambda m: classe_label(classes[m.classe_id]))
                    if avancement[mc.id][1] > avancement[mc.id][0])
                candidates.append(dict(
                    base, type='saisie_incomplete', niveau='urgent' if palier == 'J2' else 'alerte',
                    titre=f"Notes manquantes — séquence {sequence.libelle}",
                    message=f"La séquence {sequence.libelle} se termine {quand} et il manque "
                            f"{manquantes} note{'s' if manquantes > 1 else ''} : {detail}."))
    return candidates


def _recap_admins(etablissement_id, annee, aujourdhui):
    sequence = sequence_courante(annee)
    if sequence is None or (sequence.date_debut and sequence.date_debut > aujourdhui):
        return []
    admins = _comptes_actifs(etablissement_id, 'Admin')
    liens, classes, _ = _liens_etablissement(etablissement_id)
    if not admins or not liens:
        return []

    avancement = _avancement_par_mc(etablissement_id, annee, sequence, liens)
    saisies = sum(s for s, _ in avancement.values())
    attendues = sum(a for _, a in avancement.values())
    if not attendues:
        return []

    par_classe = {}
    for mc in liens:
        s, a = avancement[mc.id]
        cumul = par_classe.setdefault(mc.classe_id, [0, 0])
        cumul[0] += s
        cumul[1] += a
    en_retard = sorted(((cid, s, a) for cid, (s, a) in par_classe.items() if a and s < a),
                       key=lambda x: (_pct(x[1], x[2]), classe_label(classes[x[0]])))
    enseignants_en_retard = {mc.enseignant_id for mc in liens if avancement[mc.id][0] < avancement[mc.id][1]}

    message = (f"Séquence {sequence.libelle} : {_pct(saisies, attendues)} % des notes saisies "
               f"({saisies}/{attendues}).")
    if en_retard:
        message += " Classes les moins avancées : " + _enumeration(
            f"{classe_label(classes[cid])} ({_pct(s, a)} %)" for cid, s, a in en_retard) + "."
        message += f" Enseignants n'ayant pas terminé : {len(enseignants_en_retard)}."
    else:
        message += " Toutes les classes sont complètes."

    annee_iso, semaine, _ = aujourdhui.isocalendar()
    return [dict(utilisateur_id=uid, role='Admin', lien='/', type='recap_saisie', niveau='info',
                 cle=f"recap|{annee_iso}-S{semaine:02d}",
                 titre=f"Saisie des notes — semaine {semaine}", message=message)
            for uid in admins]


# ---------------------------------------------------------------------------
# Génération
# ---------------------------------------------------------------------------

def _inserer(etablissement_id, candidates, reessai=True):
    """Insère les notifications pas encore créées. Retourne le nombre ajouté."""
    if not candidates:
        return 0
    existantes = {
        (u, r, c) for u, r, c in db.session.query(Notification.utilisateur_id, Notification.role, Notification.cle)
        .filter(Notification.etablissement_id == etablissement_id,
                Notification.cle.in_({c['cle'] for c in candidates})).all()
    }
    nouvelles = []
    for c in candidates:
        cle = (c['utilisateur_id'], c['role'], c['cle'])
        if cle in existantes:
            continue
        existantes.add(cle)
        nouvelles.append(Notification(etablissement_id=etablissement_id, **c))
    if not nouvelles:
        return 0
    db.session.add_all(nouvelles)
    try:
        db.session.commit()
    except IntegrityError:
        # Génération simultanée sur un autre processus : elle a créé tout
        # ou partie des mêmes notifications. On repart de l'état en base.
        db.session.rollback()
        if not reessai:
            raise
        return _inserer(etablissement_id, candidates, reessai=False)
    return len(nouvelles)


def generer_notifications(etablissement_id, aujourdhui=None):
    """Crée les notifications dues ce jour pour l'établissement et purge les
    anciennes notifications lues. Retourne le nombre de notifications créées."""
    aujourdhui = aujourdhui or date.today()
    Notification.query.filter(
        Notification.etablissement_id == etablissement_id,
        Notification.lue_le.isnot(None),
        Notification.lue_le < datetime.utcnow() - CONSERVATION_LUES,
    ).delete(synchronize_session=False)
    db.session.commit()

    annee = annee_active(etablissement_id)
    if annee is None:
        return 0
    candidates = (_paiements_parents(etablissement_id, annee, aujourdhui)
                  + _sequences_enseignants(etablissement_id, annee, aujourdhui)
                  + _recap_admins(etablissement_id, annee, aujourdhui))
    return _inserer(etablissement_id, candidates)


# Délai minimal entre deux générations d'un même établissement (par
# processus). Court, pour qu'un compte ouvert ou une échéance saisie dans la
# journée soient pris en compte rapidement ; la génération étant idempotente,
# deux processus qui génèrent en même temps ne créent pas de doublon.
INTERVALLE_GENERATION = timedelta(minutes=15)
_DERNIER_PASSAGE = {}  # {etablissement_id: datetime du dernier passage}


def assurer_generation(etablissement_id):
    """Génère si le dernier passage date de plus de INTERVALLE_GENERATION.
    Une erreur de génération ne doit jamais empêcher l'affichage des
    notifications."""
    if not etablissement_id:
        return
    maintenant = datetime.utcnow()
    dernier = _DERNIER_PASSAGE.get(etablissement_id)
    if dernier and maintenant - dernier < INTERVALLE_GENERATION:
        return
    try:
        generer_notifications(etablissement_id)
        _DERNIER_PASSAGE[etablissement_id] = maintenant
    except Exception:  # noqa: BLE001 — journalisé, l'affichage continue
        db.session.rollback()
        from flask import current_app
        current_app.logger.exception("Génération des notifications impossible (établissement %s)", etablissement_id)


def invalider_generation(etablissement_id):
    """À appeler quand de nouveaux destinataires apparaissent (accès parent
    ouvert, enfant rattaché) : la prochaine lecture régénère sans attendre."""
    _DERNIER_PASSAGE.pop(etablissement_id, None)


def generer_pour_tous(aujourdhui=None):
    """Commande `flask notifications` : tous les établissements."""
    total = 0
    for etab in Etablissement.query.all():
        total += generer_notifications(etab.id, aujourdhui)
    return total


# ---------------------------------------------------------------------------
# Lecture
# ---------------------------------------------------------------------------

def _query(utilisateur_id, role):
    return Notification.query.filter_by(utilisateur_id=utilisateur_id, role=role)


def lister(utilisateur_id, role, limite=LIMITE_LISTE):
    if not role:
        return {"notifications": [], "non_lues": 0}
    notifications = _query(utilisateur_id, role).order_by(Notification.cree_le.desc(), Notification.id.desc()) \
        .limit(limite).all()
    non_lues = _query(utilisateur_id, role).filter(Notification.lue_le.is_(None)).count()
    return {"notifications": [n.to_dict() for n in notifications], "non_lues": non_lues}


def marquer_lue(utilisateur_id, role, notification_id):
    n = _query(utilisateur_id, role).filter_by(id=notification_id).first()
    if n is None:
        return {"erreur": "Notification introuvable"}, 404
    if n.lue_le is None:
        n.lue_le = datetime.utcnow()
        db.session.commit()
    return n.to_dict(), 200


def tout_marquer_lu(utilisateur_id, role):
    nb = _query(utilisateur_id, role).filter(Notification.lue_le.is_(None)) \
        .update({Notification.lue_le: datetime.utcnow()}, synchronize_session=False)
    db.session.commit()
    return {"marquees": nb}, 200


def echeances_saisie(etablissement_id):
    """Dates de fin des séquences de l'année active : le front s'en sert,
    même hors connexion (copie locale), pour prévenir qu'une saisie gardée
    sur l'appareil doit partir avant la fin de sa séquence."""
    annee = annee_active(etablissement_id) if etablissement_id else None
    if annee is None:
        return {"sequences": []}
    return {"sequences": [
        {"id": s.id, "libelle": s.libelle, "date_fin": s.date_fin.isoformat() if s.date_fin else None}
        for s in sequences_annee(annee.id)
    ]}
