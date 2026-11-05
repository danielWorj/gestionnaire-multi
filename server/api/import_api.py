from flask import Blueprint, jsonify, request, send_file
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from services import (
    import_classes_services, import_eleves_services, import_emploi_du_temps_services, import_enseignants_services,
    import_matieres_services, import_notes_services,
)


# ---------------------------------------------------------------------------
# Import de masse depuis les archives des établissements (CSV, Excel, Word).
#
#   POST /api/import/<module>/analyser  multipart : fichiers[] (+ texte collé)
#        -> tableaux trouvés dans les fichiers, sans rien enregistrer
#   POST /api/import/<module>/traiter   JSON : blocs, mapping, options,
#        corrections, exclues, valider -> aperçu (valider=false) ou import
#   GET  /api/import/<module>/modele    -> modèle Excel vierge
#
# module : eleves, enseignants, classes, matieres, emploi-du-temps, notes.
#
# Droits : élèves = mêmes rôles que eleve_bp (Admin, SuperAdmin, Secretaire) ;
# enseignants / classes / matières = Admin et SuperAdmin uniquement (l'import
# des enseignants crée des comptes de connexion, réservé à l'Admin comme
# POST /api/auth/utilisateurs ; la création de classes l'est déjà dans
# classe_bp) ; emploi du temps = mêmes rôles que horaire_bp (Censeur et
# Surveillant limités à leurs classes assignées) ; notes = Enseignant seul,
# dans ses propres matières-classes, comme l'écriture sur note_bp.
# Établissement résolu comme dans les blueprints cloisonnés : claim JWT pour
# un compte d'établissement, ?etablissement_id=<id> pour le SuperAdmin
# (ajouté automatiquement par web/src/lib/api.js).
#
# Les services qui ont UTILISE_CONTEXTE = True reçoivent en plus le rôle et
# l'identité de l'utilisateur (périmètre résolu en direct, jamais depuis un
# claim mis en cache).
# ---------------------------------------------------------------------------

MODULES = {
    'eleves': (import_eleves_services, ("Admin", "SuperAdmin", "Secretaire"), 'modele-import-eleves.xlsx'),
    'enseignants': (import_enseignants_services, ("Admin", "SuperAdmin"), 'modele-import-enseignants.xlsx'),
    'classes': (import_classes_services, ("Admin", "SuperAdmin"), 'modele-import-classes.xlsx'),
    'matieres': (import_matieres_services, ("Admin", "SuperAdmin"), 'modele-import-matieres.xlsx'),
    'emploi-du-temps': (import_emploi_du_temps_services, ("Admin", "SuperAdmin", "Censeur", "Surveillant"),
                        'modele-import-emploi-du-temps.xlsx'),
    'notes': (import_notes_services, ("Enseignant",), 'modele-import-notes.xlsx'),
}
TAILLE_MAX_FICHIER = 15 * 1024 * 1024

import_bp = Blueprint('import_api', __name__, url_prefix='/api/import')


@import_bp.before_request
@jwt_required()
def _require_role():
    module = (request.view_args or {}).get('module')
    if module not in MODULES:
        return jsonify({"erreur": "Import inconnu"}), 404
    if get_jwt().get("role") not in MODULES[module][1]:
        return jsonify({"erreur": "Accès non autorisé"}), 403


def _etablissement_id():
    claims = get_jwt()
    if claims.get("role") == "SuperAdmin":
        return request.args.get("etablissement_id", type=int)
    return claims.get("etablissement_id")


@import_bp.route('/<module>/analyser', methods=['POST'])
def analyser(module):
    if not _etablissement_id():
        return jsonify({"erreur": "etablissement_id requis"}), 400
    fichiers = []
    for fichier in request.files.getlist('fichiers'):
        contenu = fichier.read(TAILLE_MAX_FICHIER + 1)
        if len(contenu) > TAILLE_MAX_FICHIER:
            return jsonify({"erreur": f"« {fichier.filename} » dépasse 15 Mo."}), 400
        fichiers.append((fichier.filename or 'fichier', contenu))
    texte = request.form.get('texte') or ''
    if not fichiers and not texte.strip():
        return jsonify({"erreur": "Aucun fichier reçu."}), 400
    blocs, erreurs = MODULES[module][0].analyser_fichiers(fichiers, texte)
    return jsonify({"blocs": blocs, "erreurs": erreurs}), 200


@import_bp.route('/<module>/traiter', methods=['POST'])
def traiter(module):
    etab_id = _etablissement_id()
    if not etab_id:
        return jsonify({"erreur": "etablissement_id requis"}), 400
    payload = request.get_json(silent=True) or {}
    service = MODULES[module][0]
    extra = {}
    if getattr(service, 'UTILISE_CONTEXTE', False):
        extra['contexte'] = {'role': get_jwt().get("role"), 'user_id': int(get_jwt_identity())}
    result, status = service.traiter(etab_id, payload, valider=bool(payload.get('valider')), **extra)
    return jsonify(result), status


@import_bp.route('/<module>/modele', methods=['GET'])
def modele(module):
    return send_file(
        MODULES[module][0].generer_modele_xlsx(),
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        as_attachment=True,
        download_name=MODULES[module][2],
    )
