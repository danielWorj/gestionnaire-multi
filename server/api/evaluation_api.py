from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity

from services.evaluation_services import (
    get_all_notes_scoped, get_note_scoped, create_note_scoped, update_note_scoped, delete_note_scoped,
    resolve_enseignant_matiere_classe_ids,
    get_all_disciplines_scoped, get_discipline_scoped, create_discipline_scoped,
    update_discipline_scoped, delete_discipline_scoped,
    notes_saisies_par_mc as _notes_saisies_par_mc,
)
# resolve_classe_ids_restriction : réutilisé pour note_bp/discipline_bp (restriction
# Censeur/Surveillant) — même résolution que pour TitulaireClasse/MatiereClasse
# (pedagogie_api.py), Classe (structure_api.py), Horaire (emploi_du_temps_api.py) et
# Inscription (inscription_api.py) — cf. synthèse d'assignation Censeur/Surveillant ↔ Classe.
# resolve_enseignant_profil : équivalent pour un Enseignant, résout son profil
# métier (pedagogie_models.Enseignant) depuis son user_id, pour ensuite ne lui
# ouvrir que SES PROPRES MatiereClasse sur ce module (cf. note_bp ci-dessous).
from services.pedagogie_services import (
    resolve_classe_ids_restriction, resolve_enseignant_profil, modifier_coefficient_enseignant,
    classe_ids_titulaire,
)
# Modèles nécessaires aux blueprints ENSEIGNANT et CENSEUR en fin de fichier
# (« mon espace » : classes/matières-classe, années/trimestres/séquences,
# liste des élèves). Enseignant : utilisé par censeur_espace_bp pour
# enrichir matieres_classe avec le nom de l'enseignant titulaire.
from models.structure_models import (
    Classe, AnneeScolaire, Trimestre, Sequence, effectifs_classes,
    annee_active as annee_active_etablissement, sequence_courante as _sequence_courante,
    cle_trimestre, trier_sequences,
)
from models.pedagogie_models import Matiere, MatiereClasse, Enseignant
from models.inscription_models import Inscription, Eleve, STATUTS_INSCRIPTION_EN_COURS
# CreneauHoraire/Horaire : nécessaires UNIQUEMENT à enseignant_horaire()
# ci-dessous (page /enseignant/horaire, cf. templates/enseignant/horaire.html)
# — emploi_du_temps_api.py (horaire_bp / creneau_horaire_bp) n'autorise pas
# le rôle "Enseignant" (ROLES_ACCES_EMPLOI_DU_TEMPS = Admin/SuperAdmin/
# Censeur/Surveillant), d'où ce point d'entrée dédié, pré-filtré et
# pré-enrichi côté serveur, sur le même modèle que enseignant_mon_espace.
from models.emploi_du_temps_models import CreneauHoraire, Horaire
# Épreuves déposées par l'enseignant (liste paginée, dépôt, suppression) : toute
# la logique (formats, taille, stockage, périmètre) est dans le service, ces
# routes ne font que résoudre l'enseignant connecté — cf. plus bas.
from services.mode_evaluation_services import composantes as composantes_du_mode, mode_de_annee
from services.epreuve_services import (
    lister_epreuves, deposer_epreuve, supprimer_epreuve, get_epreuve_scoped,
)
# Comptage des notes saisies (avancement des cartes de classes) : règle
# commune, cf. evaluation_services.notes_saisies_par_mc.


# ---------------------------------------------------------------------------
# Blueprint NOTE — cloisonné par etablissement_id (indirect, via
# matiere_classe_id -> MatiereClasse.classe_id -> Classe.etablissement_id ;
# même famille que horaire_bp dans emploi_du_temps_api.py).
#
# Accès en LECTURE (GET) pour Admin, SuperAdmin, Censeur, Surveillant ET
# Enseignant.
#
# Accès en ÉCRITURE (POST/PUT/DELETE) :
# - Enseignant : uniquement sur les MatiereClasse qui LUI ont été attribuées
#   par l'Admin (cf. resolve_enseignant_matiere_classe_ids) ;
# - Admin : toutes les matières-classe de SON établissement ;
# - SuperAdmin : toutes les matières-classe de l'établissement qu'il a
#   choisi (?etablissement_id=), pour saisir à la place d'un établissement
#   qui le demande (zone sans réseau mobile, par exemple).
# Chaque saisie est tracée à son auteur dans le journal d'audit. Ni le
# Censeur ni le Surveillant ne peuvent saisir une note.
#
# Censeur/Surveillant sont en outre restreints en LECTURE aux classes qui
# leur ont été assignées (classe_ids_restriction), comme pour
# horaire_bp/inscription_bp. Enseignant est restreint (lecture ET écriture)
# à ses propres matières-classe (matiere_classe_ids_restriction) — les deux
# restrictions sont mutuellement exclusives selon le rôle connecté.
#
# etablissement_id résolu uniformément sur les 4 verbes via ?etablissement_id=
# pour le SuperAdmin (jamais depuis le corps de la requête) : comme pour
# Horaire, Note ne porte pas de colonne etablissement_id propre, ce paramètre
# ne sert qu'à valider le contexte (inscription, matiere_classe, sequence
# doivent tous lui appartenir).
# ---------------------------------------------------------------------------

ROLES_LECTURE_NOTE = ("Admin", "SuperAdmin", "Censeur", "Surveillant", "Enseignant")
ROLES_ECRITURE_NOTE = ("Enseignant", "Admin", "SuperAdmin")

note_bp = Blueprint('note_api', __name__, url_prefix='/api/notes')


@note_bp.before_request
@jwt_required()
def _require_role_note():
    role = get_jwt().get("role")
    if role not in ROLES_LECTURE_NOTE:
        return jsonify({"erreur": "Accès non autorisé"}), 403
    # Écriture : Enseignant (ses matières), Admin et SuperAdmin (tout
    # l'établissement) ; Censeur/Surveillant restent en lecture seule.
    if request.method != "GET" and role not in ROLES_ECRITURE_NOTE:
        return jsonify({"erreur": "Seul l'enseignant titulaire peut saisir ou modifier une note"}), 403


def _resolve_etablissement_id_note():
    """- Admin/Censeur/Surveillant/Enseignant : toujours celui de son propre
      compte (claim JWT)
    - SuperAdmin : celui passé en query param, pour consulter un
      établissement précis"""
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        return request.args.get("etablissement_id", type=int)
    return claims.get("etablissement_id")


def _current_classe_restriction_note():
    """None sauf pour Censeur/Surveillant (set() des classe_id assignées,
    résolu EN DIRECT depuis le user_id courant — jamais depuis un claim mis
    en cache, cf. pedagogie_services.resolve_classe_ids_restriction). Sans
    effet pour Enseignant, dont le périmètre est géré séparément par
    _current_matiere_classe_restriction ci-dessous."""
    claims = get_jwt()
    role = claims.get("role")
    if role not in ("Censeur", "Surveillant"):
        return None
    return resolve_classe_ids_restriction(role, int(get_jwt_identity()))


def _current_matiere_classe_restriction():
    """None sauf pour Enseignant : set() des matiere_classe_id qui lui ont
    été attribuées, résolu EN DIRECT depuis son user_id (get_jwt_identity()),
    jamais depuis un claim mis en cache — même philosophie que
    resolve_classe_ids_restriction pour Censeur/Surveillant. Potentiellement
    vide si son profil Enseignant n'est pas encore relié à son compte de
    connexion (Enseignant.utilisateur_id), ou ne s'est vu attribuer aucune
    matière-classe : dans ce cas il ne voit/n'écrit aucune Note plutôt que
    tout l'établissement."""
    claims = get_jwt()
    if claims.get("role") != "Enseignant":
        return None
    profil = resolve_enseignant_profil(int(get_jwt_identity()))
    mes_mc = resolve_enseignant_matiere_classe_ids(profil.id if profil else None)
    if request.method == "GET":
        # Titulaire : consultation de toutes les matières de ses classes.
        titulaire = classe_ids_titulaire(int(get_jwt_identity()))
        if titulaire:
            mes_mc |= {mc.id for mc in MatiereClasse.query.filter(MatiereClasse.classe_id.in_(titulaire)).all()}
    return mes_mc


@note_bp.route('/', methods=['GET'])
def note_get_all():
    etab_id = _resolve_etablissement_id_note()
    if etab_id is None:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    filtres = {cle: request.args.get(cle, type=int) for cle in ('matiere_classe_id', 'classe_id', 'sequence_id')}
    return jsonify(get_all_notes_scoped(
        etab_id, _current_classe_restriction_note(), _current_matiere_classe_restriction(), filtres
    )), 200


@note_bp.route('/', methods=['POST'])
def note_create():
    etab_id = _resolve_etablissement_id_note()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    # before_request garantit ici role in ROLES_ECRITURE_NOTE : restriction =
    # set() concret (potentiellement vide) pour l'Enseignant, None pour le
    # SuperAdmin (tout l'établissement choisi).
    result, status = create_note_scoped((request.get_json(silent=True) or {}), etab_id, _current_matiere_classe_restriction())
    return jsonify(result), status


@note_bp.route('/<int:id>', methods=['GET'])
def note_get_one(id):
    etab_id = _resolve_etablissement_id_note()
    entity = get_note_scoped(
        id, etab_id, _current_classe_restriction_note(), _current_matiere_classe_restriction()
    ) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Note non trouvée"}), 404
    return jsonify(entity.to_dict()), 200


@note_bp.route('/<int:id>', methods=['PUT'])
def note_update(id):
    etab_id = _resolve_etablissement_id_note()
    mc_restriction = _current_matiere_classe_restriction()
    entity = get_note_scoped(id, etab_id, None, mc_restriction) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Note non trouvée"}), 404
    result, status = update_note_scoped(entity, (request.get_json(silent=True) or {}), etab_id, mc_restriction)
    return jsonify(result), status


@note_bp.route('/<int:id>', methods=['DELETE'])
def note_delete(id):
    etab_id = _resolve_etablissement_id_note()
    mc_restriction = _current_matiere_classe_restriction()
    entity = get_note_scoped(id, etab_id, None, mc_restriction) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Note non trouvée"}), 404
    result, status = delete_note_scoped(entity, etab_id, mc_restriction)
    return jsonify(result), status


# ---------------------------------------------------------------------------
# Blueprint DISCIPLINE — cloisonné par etablissement_id (indirect, via
# inscription_id -> Inscription.classe_id -> Classe.etablissement_id ; même
# famille que inscription_bp dans inscription_api.py).
#
# Réservé à Admin, SuperAdmin, Censeur et Surveillant, en LECTURE ET
# ÉCRITURE : contrairement à note_bp ci-dessus, l'Enseignant n'a ICI AUCUN
# accès (ni lecture, ni écriture) — le suivi disciplinaire relève de
# l'encadrement (Censeur/Surveillant), pas de l'enseignant, qui se limite à
# ses notes.
#
# Censeur/Surveillant restreints, sur TOUS les verbes (contrairement à leur
# accès en lecture seule sur inscription_bp), aux classes qui leur ont été
# assignées (classe_ids_restriction) — ils ont ici un accès complet
# (lecture + écriture) à leur périmètre, pas seulement en consultation.
# ---------------------------------------------------------------------------

# Enseignant : uniquement les classes dont il est titulaire.
ROLES_DISCIPLINE = ("Admin", "SuperAdmin", "Censeur", "Surveillant", "Enseignant")

discipline_bp = Blueprint('discipline_api', __name__, url_prefix='/api/disciplines')


@discipline_bp.before_request
@jwt_required()
def _require_role_discipline():
    if get_jwt().get("role") not in ROLES_DISCIPLINE:
        return jsonify({"erreur": "Accès non autorisé"}), 403


def _resolve_etablissement_id_discipline():
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        return request.args.get("etablissement_id", type=int)
    return claims.get("etablissement_id")


def _current_classe_restriction_discipline():
    """None pour Admin/SuperAdmin (pas de restriction) ; pour un
    Censeur/Surveillant, le set() des classe_id qui lui ont été assignées,
    résolu EN DIRECT depuis son user_id courant."""
    claims = get_jwt()
    role = claims.get("role")
    if role in ("Admin", "SuperAdmin"):
        return None
    return resolve_classe_ids_restriction(role, int(get_jwt_identity()))


@discipline_bp.route('/', methods=['GET'])
def discipline_get_all():
    etab_id = _resolve_etablissement_id_discipline()
    if etab_id is None:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    filtres = {cle: request.args.get(cle, type=int) for cle in ('classe_id', 'sequence_id')}
    return jsonify(get_all_disciplines_scoped(etab_id, _current_classe_restriction_discipline(), filtres)), 200


@discipline_bp.route('/', methods=['POST'])
def discipline_create():
    etab_id = _resolve_etablissement_id_discipline()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    result, status = create_discipline_scoped(
        (request.get_json(silent=True) or {}), etab_id, _current_classe_restriction_discipline()
    )
    return jsonify(result), status


@discipline_bp.route('/<int:id>', methods=['GET'])
def discipline_get_one(id):
    etab_id = _resolve_etablissement_id_discipline()
    entity = get_discipline_scoped(id, etab_id, _current_classe_restriction_discipline()) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Fiche disciplinaire non trouvée"}), 404
    return jsonify(entity.to_dict()), 200


@discipline_bp.route('/<int:id>', methods=['PUT'])
def discipline_update(id):
    etab_id = _resolve_etablissement_id_discipline()
    entity = get_discipline_scoped(id, etab_id, _current_classe_restriction_discipline()) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Fiche disciplinaire non trouvée"}), 404
    result, status = update_discipline_scoped(
        entity, (request.get_json(silent=True) or {}), etab_id, _current_classe_restriction_discipline()
    )
    return jsonify(result), status


@discipline_bp.route('/<int:id>', methods=['DELETE'])
def discipline_delete(id):
    etab_id = _resolve_etablissement_id_discipline()
    entity = get_discipline_scoped(id, etab_id, _current_classe_restriction_discipline()) if etab_id else None
    if not entity:
        return jsonify({"erreur": "Fiche disciplinaire non trouvée"}), 404
    result, status = delete_discipline_scoped(
        entity, etab_id, _current_classe_restriction_discipline()
    )
    return jsonify(result), status


# ---------------------------------------------------------------------------
# Blueprint ENSEIGNANT — « mon espace », réservé au SEUL rôle Enseignant.
# En LECTURE (GET), à une exception près : PUT .../matieres-classe/<id>/coefficient
# (l'enseignant règle le coefficient de SA matière, cf. plus bas).
#
# Alimente la page /enseignant/notes (notes.html) : la grille de saisie a
# besoin, en plus de /api/notes/ ci-dessus, de connaître les matières-classe
# attribuées à l'enseignant connecté, les années/trimestres/séquences de son
# établissement et la liste des élèves d'une de ses classes.
#
# Placé ICI plutôt que dans un module à part, et surtout pas dans
# structure_api.py / pedagogie_api.py / inscription_api.py : ces blueprints
# n'autorisent pas le rôle "Enseignant" (matiere_classe_bp, classe_bp,
# annee_scolaire_bp, trimestre_bp, sequence_bp, inscription_bp) et les lui
# ouvrir exposerait TOUT l'établissement à chaque enseignant. Ici le périmètre
# est déduit du profil connecté :
#   utilisateur -> Enseignant -> MatiereClasse attribuées -> Classe -> Inscription
# en réutilisant exactement les mêmes briques que note_bp
# (resolve_enseignant_profil + resolve_enseignant_matiere_classe_ids) : ce que
# l'enseignant voit ici est donc, par construction, exactement ce sur quoi il
# peut écrire via /api/notes/.
#
# etablissement_id TOUJOURS pris dans le claim JWT — jamais en query param
# (contrairement au SuperAdmin sur les autres blueprints) : un enseignant n'a
# aucune raison de désigner un autre établissement que le sien.
#
# COLONNES SUPPOSÉES (à ajuster si vos modèles utilisent d'autres noms) :
#   MatiereClasse : id, classe_id, matiere_id, coefficient
#   Classe        : id, etablissement_id, libelle|nom
#   Matiere       : id, libelle|nom
#   AnneeScolaire : id, etablissement_id, libelle|nom, active|est_active|en_cours
#   Trimestre     : id, annee_scolaire_id, libelle|nom
#   Sequence      : id, trimestre_id, libelle|nom
#   Inscription   : id, eleve_id, classe_id, annee_scolaire_id
#   Eleve         : id, nom, prenom, matricule, sexe
# Les libellés passent par _libelle(), tolérant libelle/nom/intitule/code.
# ---------------------------------------------------------------------------

# NB : le blueprint s'appelle 'enseignant_espace_api' (et NON 'enseignant_api')
# car pedagogie_api.py enregistre déjà un Blueprint('enseignant_api') pour
# /api/enseignants (gestion des comptes enseignants par l'Admin). Deux
# blueprints ne peuvent pas porter le même nom dans une même application
# Flask — d'où aussi le nom de variable enseignant_espace_bp, à ne pas
# confondre avec pedagogie_api.enseignant_bp lors des imports dans app.py.
enseignant_espace_bp = Blueprint('enseignant_espace_api', __name__, url_prefix='/api/enseignant')


@enseignant_espace_bp.before_request
@jwt_required()
def _require_enseignant():
    if get_jwt().get("role") != "Enseignant":
        return jsonify({"erreur": "Accès réservé aux enseignants"}), 403


def _premier_attr(obj, *noms, defaut=None):
    """Premier attribut non nul trouvé parmi *noms — évite de casser si le
    modèle nomme son libellé 'nom' plutôt que 'libelle'."""
    for nom in noms:
        valeur = getattr(obj, nom, None)
        if valeur is not None:
            return valeur
    return defaut


def _libelle(obj, defaut):
    return _premier_attr(obj, "libelle", "nom", "intitule", "code", defaut=defaut)


def _classe_label(classe):
    """Classe (structure_models.py) ne porte NI 'libelle' NI 'nom' : son nom
    se déduit de Cycle.libelle (via la relation classe.cycle, backref défini
    dans Cycle.classes) + Classe.option, ex. cycle '6ème' + option 'A' ->
    '6ème A'. _libelle() seul ne peut pas le trouver (il cherche des
    attributs directs sur l'objet), d'où le fallback 'Classe #<id>' observé
    jusqu'ici."""
    if classe is None:
        return None
    cycle_libelle = classe.cycle.libelle if classe.cycle else None
    if cycle_libelle and classe.option:
        return f"{cycle_libelle} {classe.option}"
    return cycle_libelle or classe.option or f"Classe #{classe.id}"


def _est_active(annee):
    return bool(_premier_attr(annee, "active", "est_active", "en_cours", "actuelle",
                              "is_active", defaut=False))


def _annee_json(annee):
    """Année des espaces enseignant/censeur, avec son mode d'évaluation et
    les évaluations à saisir par séquence (une seule « note » en Lycée)."""
    mode = mode_de_annee(annee)
    return {
        "id": annee.id,
        "libelle": _libelle(annee, f"Année #{annee.id}"),
        "active": _est_active(annee),
        "mode_evaluation": mode,
        "composantes": [{"code": c, "libelle": l, "poids": p} for c, l, p in composantes_du_mode(mode)],
    }


def _sequence_json(sequence):
    if sequence is None:
        return None
    return {
        "id": sequence.id,
        "libelle": _libelle(sequence, f"Séquence #{sequence.id}"),
        "trimestre_id": sequence.trimestre_id,
        "trimestre_libelle": _libelle(sequence.trimestre, None) if sequence.trimestre else None,
    }


def _etablissement_id_enseignant():
    return get_jwt().get("etablissement_id")


def _mes_matieres_classe(etab_id):
    """(profil, [MatiereClasse]) de l'enseignant connecté, filtrées sur son
    établissement. profil vaut None si le compte de connexion n'est relié à
    aucun profil Enseignant (Enseignant.utilisateur_id non renseigné) : cas
    traité explicitement par les endpoints, avec un message actionnable plutôt
    qu'une liste vide silencieuse. Même résolution EN DIRECT depuis le user_id
    courant que _current_matiere_classe_restriction pour note_bp."""
    profil = resolve_enseignant_profil(int(get_jwt_identity()))
    if profil is None:
        return None, []

    mc_ids = resolve_enseignant_matiere_classe_ids(profil.id) or set()
    if not mc_ids:
        return profil, []

    liens = (
        MatiereClasse.query
        .join(Classe, Classe.id == MatiereClasse.classe_id)
        .filter(MatiereClasse.id.in_(mc_ids))
        .filter(Classe.etablissement_id == etab_id)
        .all()
    )
    return profil, liens


ERREUR_PROFIL_NON_RELIE = {
    "erreur": "Aucun profil enseignant n'est relié à ce compte. "
              "Contactez l'administration de votre établissement."
}


# ---------------------------------------------------------------------------
# GET /api/enseignant/mon-espace
# -> {matieres_classe: [{id, classe_id, classe_label, classe_option, cycle_libelle, effectif,
#                        matiere_id, matiere_libelle, coefficient,
#                        notes_saisies}],
#     annees_scolaires: [{id, libelle, active}],
#     sequence_courante: {id, libelle, trimestre_id, trimestre_libelle} | null}
# notes_saisies : avancement de la saisie sur la séquence courante de
# l'année active (cf. _sequence_courante), à comparer à effectif.
# ---------------------------------------------------------------------------

@enseignant_espace_bp.route('/mon-espace', methods=['GET'])
def enseignant_mon_espace():
    etab_id = _etablissement_id_enseignant()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400

    profil, liens = _mes_matieres_classe(etab_id)
    if profil is None:
        return jsonify(ERREUR_PROFIL_NON_RELIE), 404

    annees = (
        AnneeScolaire.query
        .filter_by(etablissement_id=etab_id)
        .order_by(AnneeScolaire.id.desc())
        .all()
    )
    annee_active = annee_active_etablissement(etab_id)

    classe_ids = {lien.classe_id for lien in liens}
    matiere_ids = {lien.matiere_id for lien in liens}

    classes = ({c.id: c for c in Classe.query.filter(Classe.id.in_(classe_ids)).all()}
               if classe_ids else {})
    matieres = ({m.id: m for m in Matiere.query.filter(Matiere.id.in_(matiere_ids)).all()}
                if matiere_ids else {})

    # Effectif par classe sur l'année active (élèves en cours, cf.
    # structure_models.effectifs_classes), en une seule requête agrégée.
    effectifs = (effectifs_classes(etab_id, classe_ids, annee_active.id)
                 if classe_ids and annee_active is not None else {})

    sequence = _sequence_courante(annee_active)
    notes_saisies = _notes_saisies_par_mc([lien.id for lien in liens], sequence, annee_active)

    def _cycle_libelle(classe_id):
        classe = classes.get(classe_id)
        return classe.cycle.libelle if classe and classe.cycle else None

    matieres_classe = [
        {
            "id": lien.id,
            "classe_id": lien.classe_id,
            "classe_label": _classe_label(classes.get(lien.classe_id)),
            "classe_option": getattr(classes.get(lien.classe_id), "option", None),
            "cycle_libelle": _cycle_libelle(lien.classe_id),
            "effectif": effectifs.get(lien.classe_id, 0),
            "matiere_id": lien.matiere_id,
            "matiere_libelle": _libelle(matieres.get(lien.matiere_id), f"Matière #{lien.matiere_id}"),
            "coefficient": _premier_attr(lien, "coefficient", defaut=1),
            "notes_saisies": notes_saisies.get(lien.id, 0),
        }
        for lien in liens
    ]
    matieres_classe.sort(key=lambda mc: (mc["classe_label"], mc["matiere_libelle"]))

    return jsonify({
        "matieres_classe": matieres_classe,
        "annees_scolaires": [_annee_json(annee) for annee in annees],
        "sequence_courante": _sequence_json(sequence),
    }), 200


# ---------------------------------------------------------------------------
# PUT /api/enseignant/matieres-classe/<id>/coefficient   {coefficient: int}
# -> {id, classe_id, matiere_id, enseignant_id, coefficient}
#
# L'enseignant règle lui-même le coefficient de la matière qu'il dispense dans
# une classe. Strictement limité à SES MatiereClasse (404 pour celle d'un
# collègue ou d'un autre établissement) et à la seule colonne coefficient
# (entier de 1 à 99). Le journal d'audit trace l'ancienne et la nouvelle
# valeur au nom de l'enseignant. Les moyennes et bulletins étant calculés à
# la volée, le nouveau coefficient s'applique immédiatement à toutes les notes
# de la matière.
# ---------------------------------------------------------------------------

@enseignant_espace_bp.route('/matieres-classe/<int:mc_id>/coefficient', methods=['PUT'])
def enseignant_modifier_coefficient(mc_id):
    etab_id = _etablissement_id_enseignant()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400

    profil = resolve_enseignant_profil(int(get_jwt_identity()))
    if profil is None:
        return jsonify(ERREUR_PROFIL_NON_RELIE), 404

    data = request.get_json(silent=True) or {}
    if "coefficient" not in data:
        return jsonify({"erreur": "coefficient requis"}), 400

    result, status = modifier_coefficient_enseignant(profil, mc_id, data["coefficient"], etab_id)
    return jsonify(result), status


# ---------------------------------------------------------------------------
# GET /api/enseignant/horaire?annee_scolaire_id=<id>
# -> {creneaux: [{id, libelle, heure_debut, heure_fin}],
#     horaires: [{id, jour_semaine, creneau_id, salle, matiere_classe_id,
#                 classe_id, classe_label, matiere_libelle}]}
#
# Alimente /enseignant/horaire (templates/enseignant/horaire.html) : la
# grille hebdomadaire personnelle de l'enseignant connecté, toutes classes/
# matières confondues. Réutilise EXACTEMENT le même périmètre que note_bp
# (_mes_matieres_classe -> resolve_enseignant_profil +
# resolve_enseignant_matiere_classe_ids) : ce que l'enseignant voit ici est,
# par construction, un sous-ensemble de ce sur quoi il peut saisir des notes.
#
# Les créneaux horaires (CreneauHoraire) sont un référentiel
# établissement-large : on renvoie ceux de l'établissement de l'enseignant
# tels quels (nécessaires pour dessiner la trame de la grille), sans
# restriction supplémentaire — contrairement aux Horaire, filtrés stricts
# sur les matiere_classe_id attribués.
# ---------------------------------------------------------------------------

@enseignant_espace_bp.route('/horaire', methods=['GET'])
def enseignant_horaire():
    etab_id = _etablissement_id_enseignant()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400

    annee_id = request.args.get("annee_scolaire_id", type=int)
    if not annee_id:
        return jsonify({"erreur": "annee_scolaire_id requis"}), 400

    profil, liens = _mes_matieres_classe(etab_id)
    if profil is None:
        return jsonify(ERREUR_PROFIL_NON_RELIE), 404

    # ?classe_id= : emploi du temps COMPLET d'une classe dont l'enseignant
    # est titulaire (toutes matières, avec le nom de chaque enseignant).
    classe_id = request.args.get("classe_id", type=int)
    if classe_id is not None:
        if classe_id not in classe_ids_titulaire(int(get_jwt_identity())):
            return jsonify({"erreur": "Vous n'êtes pas titulaire de cette classe"}), 403
        liens = MatiereClasse.query.filter_by(classe_id=classe_id).all()

    mc_par_id = {lien.id: lien for lien in liens}

    creneaux = (
        CreneauHoraire.query
        .filter_by(etablissement_id=etab_id)
        .order_by(CreneauHoraire.heure_debut)
        .all()
    )

    horaires = []
    if mc_par_id:
        horaires = (
            Horaire.query
            .filter(
                Horaire.matiere_classe_id.in_(mc_par_id.keys()),
                Horaire.annee_scolaire_id == annee_id,
            )
            .all()
        )

    classe_ids = {lien.classe_id for lien in mc_par_id.values()}
    matiere_ids = {lien.matiere_id for lien in mc_par_id.values()}
    classes = ({c.id: c for c in Classe.query.filter(Classe.id.in_(classe_ids)).all()}
               if classe_ids else {})
    matieres = ({m.id: m for m in Matiere.query.filter(Matiere.id.in_(matiere_ids)).all()}
                if matiere_ids else {})

    horaires_json = []
    for h in horaires:
        lien = mc_par_id.get(h.matiere_classe_id)
        classe = classes.get(lien.classe_id) if lien else None
        horaires_json.append({
            "id": h.id,
            "jour_semaine": h.jour_semaine,
            "creneau_id": h.creneau_id,
            "salle": h.salle,
            "matiere_classe_id": h.matiere_classe_id,
            "classe_id": lien.classe_id if lien else None,
            "classe_label": _classe_label(classe),
            "matiere_libelle": _libelle(matieres.get(lien.matiere_id) if lien else None, "Matière"),
            "enseignant_nom": (f"{lien.enseignant.prenom or ''} {lien.enseignant.nom or ''}".strip()
                               if lien and lien.enseignant else None),
        })

    return jsonify({
        "creneaux": [c.to_dict() for c in creneaux],
        "horaires": horaires_json,
    }), 200


# ---------------------------------------------------------------------------
# GET /api/enseignant/sequences?annee_scolaire_id=<id>
# -> [{trimestre_id, trimestre_libelle, sequences: [{id, libelle}]}]
# ---------------------------------------------------------------------------

@enseignant_espace_bp.route('/sequences', methods=['GET'])
def enseignant_sequences():
    etab_id = _etablissement_id_enseignant()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400

    annee_id = request.args.get("annee_scolaire_id", type=int)
    if not annee_id:
        return jsonify({"erreur": "annee_scolaire_id requis"}), 400

    # L'année doit appartenir à l'établissement de l'enseignant, sinon un
    # enseignant pourrait énumérer les trimestres d'un autre établissement en
    # devinant un id.
    annee = AnneeScolaire.query.filter_by(id=annee_id, etablissement_id=etab_id).first()
    if not annee:
        return jsonify({"erreur": "Année scolaire non trouvée"}), 404

    trimestres = sorted(Trimestre.query.filter_by(annee_scolaire_id=annee_id).all(), key=cle_trimestre)
    if not trimestres:
        return jsonify([]), 200

    sequences_par_trimestre = {}
    for sequence in trier_sequences(Sequence.query
                                    .filter(Sequence.trimestre_id.in_([t.id for t in trimestres]))
                                    .all()):
        sequences_par_trimestre.setdefault(sequence.trimestre_id, []).append({
            "id": sequence.id,
            "libelle": _libelle(sequence, f"Séquence #{sequence.id}"),
            # Saisie verrouillée (date passée ou clôture) : grille en lecture
            # seule pour l'enseignant (cf. evaluation_services.refus_verrou).
            "verrouillee": sequence.est_verrouillee(),
            "etat_saisie": sequence.etat_saisie,
        })

    return jsonify([
        {
            "trimestre_id": trimestre.id,
            "trimestre_libelle": _libelle(trimestre, f"Trimestre #{trimestre.id}"),
            "sequences": sequences_par_trimestre.get(trimestre.id, []),
        }
        for trimestre in trimestres
    ]), 200


# ---------------------------------------------------------------------------
# GET /api/enseignant/roster?classe_id=<id>&annee_scolaire_id=<id>
# -> [{inscription_id, eleve_id, nom, prenom, matricule, sexe}]
# ---------------------------------------------------------------------------

@enseignant_espace_bp.route('/roster', methods=['GET'])
def enseignant_roster():
    etab_id = _etablissement_id_enseignant()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400

    classe_id = request.args.get("classe_id", type=int)
    annee_id = request.args.get("annee_scolaire_id", type=int)
    if not classe_id or not annee_id:
        return jsonify({"erreur": "classe_id et annee_scolaire_id requis"}), 400

    profil, liens = _mes_matieres_classe(etab_id)
    if profil is None:
        return jsonify(ERREUR_PROFIL_NON_RELIE), 404

    # La classe demandée doit faire partie de celles où l'enseignant a au moins
    # une matière attribuée (liens déjà filtrés sur son établissement, cf.
    # _mes_matieres_classe) — équivalent, pour ce blueprint, du
    # matiere_classe_ids_restriction appliqué à note_bp.
    if classe_id not in {lien.classe_id for lien in liens}:
        return jsonify({"erreur": "Cette classe ne vous est pas attribuée"}), 403

    inscriptions = Inscription.query.filter(
        Inscription.classe_id == classe_id, Inscription.annee_scolaire_id == annee_id,
        Inscription.statut.in_(STATUTS_INSCRIPTION_EN_COURS),
    ).all()

    eleve_ids = {inscription.eleve_id for inscription in inscriptions}
    eleves = ({e.id: e for e in Eleve.query.filter(Eleve.id.in_(eleve_ids)).all()}
              if eleve_ids else {})

    liste = []
    for inscription in inscriptions:
        eleve = eleves.get(inscription.eleve_id)
        sexe = (_premier_attr(eleve, "sexe", "genre", defaut="") or "")
        liste.append({
            "inscription_id": inscription.id,
            "eleve_id": inscription.eleve_id,
            "nom": _premier_attr(eleve, "nom", defaut=""),
            "prenom": _premier_attr(eleve, "prenom", "prenoms", defaut=""),
            "matricule": _premier_attr(eleve, "matricule", "numero_matricule"),
            # Le front attend strictement "F" / "M" (statistiques filles/garçons)
            "sexe": sexe[:1].upper() if sexe else None,
        })

    liste.sort(key=lambda e: (e["nom"] or "", e["prenom"] or ""))
    return jsonify(liste), 200


# ---------------------------------------------------------------------------
# ÉPREUVES de l'enseignant connecté
#
# GET    /api/enseignant/epreuves?page&per_page=6&classe_id&matiere_id
#        -> {items, total, page, pages, per_page} : UNIQUEMENT ses épreuves
# POST   /api/enseignant/epreuves   (multipart : matiere_classe_id, titre,
#        fichier) -> 201 ; 403 si la matière-classe n'est pas la sienne
# DELETE /api/enseignant/epreuves/<id>  : ses épreuves uniquement (404 sinon)
#
# Les classes et matières proposées dans la fenêtre d'ajout et dans les filtres
# viennent de /api/enseignant/mon-espace (matieres_classe). Le périmètre est
# résolu EN DIRECT depuis le user_id (resolve_enseignant_profil), comme pour
# les notes, jamais depuis un claim mis en cache. Formats, taille, stockage :
# cf. services/epreuve_services.py.
# ---------------------------------------------------------------------------

EPREUVES_PAR_PAGE_ENSEIGNANT = 6


def _contexte_epreuves_enseignant():
    """((etab_id, profil), None) ou (None, (réponse, status)) : établissement du
    JWT et profil Enseignant relié au compte, ou l'erreur à renvoyer."""
    etab_id = _etablissement_id_enseignant()
    if not etab_id:
        return None, (jsonify({"erreur": "etablissement_id requis"}), 400)
    profil = resolve_enseignant_profil(int(get_jwt_identity()))
    if profil is None:
        return None, (jsonify(ERREUR_PROFIL_NON_RELIE), 404)
    return (etab_id, profil), None


@enseignant_espace_bp.route('/epreuves', methods=['GET'])
def enseignant_epreuves_liste():
    contexte, erreur = _contexte_epreuves_enseignant()
    if erreur:
        return erreur
    etab_id, profil = contexte
    return jsonify(lister_epreuves(
        etab_id,
        page=request.args.get("page", default=1, type=int),
        per_page=request.args.get("per_page", default=EPREUVES_PAR_PAGE_ENSEIGNANT, type=int),
        classe_id=request.args.get("classe_id", type=int),
        matiere_id=request.args.get("matiere_id", type=int),
        # Toujours lui-même : un enseignant_id passé en paramètre est ignoré.
        enseignant_id=profil.id,
        annee_scolaire_id=request.args.get("annee_scolaire_id", type=int),
    )), 200


@enseignant_espace_bp.route('/epreuves', methods=['POST'])
def enseignant_epreuves_depot():
    contexte, erreur = _contexte_epreuves_enseignant()
    if erreur:
        return erreur
    etab_id, profil = contexte
    result, status = deposer_epreuve(etab_id, request.form, request.files.get("fichier"), enseignant_id=profil.id)
    return jsonify(result), status


@enseignant_espace_bp.route('/epreuves/<int:epreuve_id>', methods=['DELETE'])
def enseignant_epreuves_suppression(epreuve_id):
    contexte, erreur = _contexte_epreuves_enseignant()
    if erreur:
        return erreur
    etab_id, profil = contexte
    epreuve = get_epreuve_scoped(epreuve_id, etab_id, profil.id)
    if epreuve is None:
        return jsonify({"erreur": "Épreuve non trouvée"}), 404
    result, status = supprimer_epreuve(epreuve)
    return jsonify(result), status


# ---------------------------------------------------------------------------
# Blueprint CENSEUR/SURVEILLANT — « mon espace », strict pendant de
# enseignant_espace_bp ci-dessus, mais scopé par CLASSES ASSIGNÉES
# (classe_ids_restriction, cf. resolve_classe_ids_restriction) plutôt que par
# matières-classe attribuées à un enseignant.
#
# Alimente censeur/notes.html et censeur/bulletin.html : ces pages ont
# besoin, en plus de /api/notes/ et /api/disciplines/ (déjà exposés et
# restreints correctement plus haut), de connaître :
#   - les classes assignées au Censeur/Surveillant connecté,
#   - TOUTES les matières-classe de ces classes (pas seulement celles d'un
#     enseignant en particulier),
#   - les années/trimestres/séquences de l'établissement,
#   - la liste des élèves (Eleve) d'une classe donnée — donnée à laquelle ce
#     rôle n'a sinon aucun accès direct (eleve_bp est réservé à
#     Admin/SuperAdmin/Secretaire, cf. inscription_api.py).
#
# etablissement_id TOUJOURS pris dans le claim JWT : un Censeur/Surveillant
# est toujours rattaché à un seul établissement (jamais de SuperAdmin ici,
# contrairement aux autres blueprints scoped).
# ---------------------------------------------------------------------------

censeur_espace_bp = Blueprint('censeur_espace_api', __name__, url_prefix='/api/censeur')


# Admin et SuperAdmin y accèdent aussi (toutes les classes de
# l'établissement) : c'est ce qui alimente leur page Bulletins.
# Enseignant : classes dont il est titulaire (Notes & discipline, bulletins,
# PV et emploi du temps de sa classe), cf. _mes_classe_ids_censeur.
ROLES_ESPACE_CENSEUR = ("Censeur", "Surveillant", "Admin", "SuperAdmin", "Enseignant")


@censeur_espace_bp.before_request
@jwt_required()
def _require_censeur_ou_surveillant():
    if get_jwt().get("role") not in ROLES_ESPACE_CENSEUR:
        return jsonify({"erreur": "Accès réservé aux Censeurs, Surveillants et à l'administration"}), 403


def _etablissement_id_censeur():
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        return request.args.get("etablissement_id", type=int)
    return claims.get("etablissement_id")


def _mes_classe_ids_censeur():
    """set() des classe_id accessibles : classes assignées au
    Censeur/Surveillant connecté, résolues EN DIRECT depuis son user_id
    (cf. resolve_classe_ids_restriction) ; toutes les classes de
    l'établissement pour Admin/SuperAdmin."""
    claims = get_jwt()
    restriction = resolve_classe_ids_restriction(claims.get("role"), int(get_jwt_identity()))
    if restriction is None:
        etab_id = _etablissement_id_censeur()
        return {c.id for c in Classe.query.filter_by(etablissement_id=etab_id).all()} if etab_id else set()
    return restriction


# ---------------------------------------------------------------------------
# GET /api/censeur/mon-espace
# -> {classes: [{id, label, option, cycle_libelle, effectif, matieres_total,
#                matieres_completes, notes_saisies, notes_attendues}],
#     matieres_classe: [{id, classe_id, matiere_id, matiere_libelle,
#                        coefficient, enseignant_id, enseignant_nom,
#                        notes_saisies}],
#     annees_scolaires: [{id, libelle, active}],
#     sequence_courante: {id, libelle, trimestre_id, trimestre_libelle} | null}
# Avancement (séquence courante de l'année active) : une matière est
# « complète » quand toutes les notes de l'effectif sont saisies.
# ---------------------------------------------------------------------------

@censeur_espace_bp.route('/mon-espace', methods=['GET'])
def censeur_mon_espace():
    etab_id = _etablissement_id_censeur()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400

    classe_ids = _mes_classe_ids_censeur()

    annees = (
        AnneeScolaire.query
        .filter_by(etablissement_id=etab_id)
        .order_by(AnneeScolaire.id.desc())
        .all()
    )
    annee_active = annee_active_etablissement(etab_id)
    annees_json = [_annee_json(annee) for annee in annees]

    # Aucune classe assignée : on renvoie des listes vides plutôt que
    # d'ouvrir tout l'établissement par défaut (même philosophie prudente
    # que resolve_classe_ids_restriction).
    sequence = _sequence_courante(annee_active)

    if not classe_ids:
        return jsonify({"classes": [], "matieres_classe": [], "annees_scolaires": annees_json,
                        "sequence_courante": _sequence_json(sequence)}), 200

    classes = (
        Classe.query
        .filter(Classe.id.in_(classe_ids), Classe.etablissement_id == etab_id)
        .all()
    )
    classe_ids_reels = {c.id for c in classes}

    # Effectif par classe sur l'année active, en une seule requête agrégée
    # (même logique que enseignant_mon_espace ci-dessus).
    effectifs = (effectifs_classes(etab_id, classe_ids_reels, annee_active.id)
                 if classe_ids_reels and annee_active is not None else {})

    liens = (MatiereClasse.query.filter(MatiereClasse.classe_id.in_(classe_ids_reels)).all()
             if classe_ids_reels else [])
    matiere_ids = {lien.matiere_id for lien in liens}
    enseignant_ids = {lien.enseignant_id for lien in liens if getattr(lien, "enseignant_id", None)}
    matieres = ({m.id: m for m in Matiere.query.filter(Matiere.id.in_(matiere_ids)).all()}
                if matiere_ids else {})
    enseignants = ({e.id: e for e in Enseignant.query.filter(Enseignant.id.in_(enseignant_ids)).all()}
                   if enseignant_ids else {})

    def _enseignant_nom(enseignant_id):
        enseignant = enseignants.get(enseignant_id)
        if not enseignant:
            return None
        return f"{enseignant.nom} {enseignant.prenom}".strip()

    notes_saisies = _notes_saisies_par_mc([lien.id for lien in liens], sequence, annee_active)

    matieres_classe = [
        {
            "id": lien.id,
            "classe_id": lien.classe_id,
            "matiere_id": lien.matiere_id,
            "matiere_libelle": _libelle(matieres.get(lien.matiere_id), f"Matière #{lien.matiere_id}"),
            "coefficient": _premier_attr(lien, "coefficient", defaut=1),
            "enseignant_id": getattr(lien, "enseignant_id", None),
            "enseignant_nom": _enseignant_nom(getattr(lien, "enseignant_id", None)),
            "notes_saisies": notes_saisies.get(lien.id, 0),
        }
        for lien in liens
    ]
    matieres_classe.sort(key=lambda mc: (mc["classe_id"], mc["matiere_libelle"]))

    def _classe_json(classe):
        effectif = effectifs.get(classe.id, 0)
        mcs = [mc for mc in matieres_classe if mc["classe_id"] == classe.id]
        return {
            "id": classe.id,
            "label": _classe_label(classe),
            "option": classe.option,
            "cycle_libelle": classe.cycle.libelle if classe.cycle else None,
            "effectif": effectif,
            "matieres_total": len(mcs),
            "matieres_completes": sum(1 for mc in mcs if effectif and mc["notes_saisies"] >= effectif),
            "notes_saisies": sum(min(mc["notes_saisies"], effectif) for mc in mcs),
            "notes_attendues": effectif * len(mcs),
        }

    return jsonify({
        "classes": sorted([_classe_json(c) for c in classes], key=lambda c: c["label"] or ""),
        "matieres_classe": matieres_classe,
        "annees_scolaires": annees_json,
        "sequence_courante": _sequence_json(sequence),
    }), 200


# ---------------------------------------------------------------------------
# GET /api/censeur/sequences?annee_scolaire_id=<id>
# -> [{trimestre_id, trimestre_libelle, sequences: [{id, libelle}]}]
# Identique à /api/enseignant/sequences (référentiel établissement, non
# restreint par classe) — dupliqué ici pour ne pas ouvrir /api/enseignant/*
# à un rôle Censeur/Surveillant.
# ---------------------------------------------------------------------------

@censeur_espace_bp.route('/sequences', methods=['GET'])
def censeur_sequences():
    etab_id = _etablissement_id_censeur()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400

    annee_id = request.args.get("annee_scolaire_id", type=int)
    if not annee_id:
        return jsonify({"erreur": "annee_scolaire_id requis"}), 400

    # L'année doit appartenir à l'établissement du Censeur/Surveillant,
    # sinon il pourrait énumérer les trimestres d'un autre établissement en
    # devinant un id.
    annee = AnneeScolaire.query.filter_by(id=annee_id, etablissement_id=etab_id).first()
    if not annee:
        return jsonify({"erreur": "Année scolaire non trouvée"}), 404

    trimestres = sorted(Trimestre.query.filter_by(annee_scolaire_id=annee_id).all(), key=cle_trimestre)
    if not trimestres:
        return jsonify([]), 200

    sequences_par_trimestre = {}
    for sequence in trier_sequences(Sequence.query
                                    .filter(Sequence.trimestre_id.in_([t.id for t in trimestres]))
                                    .all()):
        sequences_par_trimestre.setdefault(sequence.trimestre_id, []).append({
            "id": sequence.id,
            "libelle": _libelle(sequence, f"Séquence #{sequence.id}"),
            # Saisie verrouillée (date passée ou clôture) : grille en lecture
            # seule pour l'enseignant (cf. evaluation_services.refus_verrou).
            "verrouillee": sequence.est_verrouillee(),
            "etat_saisie": sequence.etat_saisie,
        })

    return jsonify([
        {
            "trimestre_id": trimestre.id,
            "trimestre_libelle": _libelle(trimestre, f"Trimestre #{trimestre.id}"),
            "sequences": sequences_par_trimestre.get(trimestre.id, []),
        }
        for trimestre in trimestres
    ]), 200


# ---------------------------------------------------------------------------
# GET /api/censeur/roster?classe_id=<id>&annee_scolaire_id=<id>
# -> [{inscription_id, eleve_id, nom, prenom, matricule, sexe}]
# La classe demandée DOIT faire partie des classes assignées au
# Censeur/Surveillant connecté (403 sinon) — même vérification que pour
# /api/enseignant/roster, mais contre les classes assignées plutôt que les
# matières-classe attribuées.
# ---------------------------------------------------------------------------

@censeur_espace_bp.route('/roster', methods=['GET'])
def censeur_roster():
    etab_id = _etablissement_id_censeur()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400

    classe_id = request.args.get("classe_id", type=int)
    annee_id = request.args.get("annee_scolaire_id", type=int)
    if not classe_id or not annee_id:
        return jsonify({"erreur": "classe_id et annee_scolaire_id requis"}), 400

    classe_ids = _mes_classe_ids_censeur()
    if classe_id not in classe_ids:
        return jsonify({"erreur": "Cette classe ne vous est pas assignée"}), 403

    inscriptions = Inscription.query.filter(
        Inscription.classe_id == classe_id, Inscription.annee_scolaire_id == annee_id,
        Inscription.statut.in_(STATUTS_INSCRIPTION_EN_COURS),
    ).all()

    eleve_ids = {inscription.eleve_id for inscription in inscriptions}
    eleves = ({e.id: e for e in Eleve.query.filter(Eleve.id.in_(eleve_ids)).all()}
              if eleve_ids else {})

    liste = []
    for inscription in inscriptions:
        eleve = eleves.get(inscription.eleve_id)
        sexe = (_premier_attr(eleve, "sexe", "genre", defaut="") or "")
        liste.append({
            "inscription_id": inscription.id,
            "eleve_id": inscription.eleve_id,
            "nom": _premier_attr(eleve, "nom", defaut=""),
            "prenom": _premier_attr(eleve, "prenom", "prenoms", defaut=""),
            "matricule": _premier_attr(eleve, "matricule", "numero_matricule"),
            # Le front attend strictement "F" / "M" (statistiques filles/garçons)
            "sexe": sexe[:1].upper() if sexe else None,
        })

    liste.sort(key=lambda e: (e["nom"] or "", e["prenom"] or ""))
    return jsonify(liste), 200