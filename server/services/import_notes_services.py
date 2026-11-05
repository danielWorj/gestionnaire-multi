"""Import de masse des notes d'une matière-classe depuis les fichiers de
l'enseignant (relevé de notes Excel, liste Word, tableau collé).

Même règle que la saisie à l'écran (evaluation_services) : seul
l'enseignant importe, et uniquement dans SES matières-classes. Une
matière-classe est choisie pour tout l'import ; les élèves du fichier sont
retrouvés parmi les inscrits de la classe (année active) par matricule, sinon
par nom (quel que soit l'ordre nom/prénoms).

Deux présentations de fichiers sont comprises :
- une colonne « Note » pour la séquence choisie ;
- une colonne par séquence (« Séq 1 | Séq 2 | … »), reconnue par son numéro.

« abs », « absent » -> élève absent (pas de note chiffrée, cf. Note.absent).
Une note sur 10, 40… est ramenée sur 20 (option, ou « 12/40 » dans la case).
"""

import re
from collections import Counter, defaultdict
from datetime import datetime
from difflib import SequenceMatcher

from extensions import db
from models.evaluation_models import Note
from models.inscription_models import Eleve, Inscription, STATUTS_INSCRIPTION_EN_COURS
from models.pedagogie_models import MatiereClasse
from models.structure_models import Classe, Sequence, Trimestre, annee_active
from services.evaluation_services import resolve_enseignant_matiere_classe_ids
from services.import_commun import (
    Schema, _cle_identite, _libelles_classe, analyser_avec_schema, entier, normaliser_matricule, valider_blocs,
)
from services.import_lecture import normaliser
from services.pedagogie_services import resolve_enseignant_profil

# import_api passe alors le rôle et l'identité de l'utilisateur à traiter().
UTILISE_CONTEXTE = True

CHAMPS = [
    ('matricule', 'Matricule', ''),
    ('nom_complet', 'Nom et prénoms', 'Dans n\'importe quel ordre'),
    ('nom', 'Nom', ''),
    ('prenom', 'Prénom(s)', ''),
    ('note', 'Note', 'Note de la séquence choisie ; « abs » = absent'),
    ('note_sequence', 'Note de la séquence en en-tête', 'Une colonne par séquence : « Séq 1 », « Séq 2 »…'),
]

SYNONYMES = {
    'numero': ['n', 'no', 'num', 'numero', 'n d ordre', 'ordre', 'rang'],
    'matricule': ['matricule', 'matricules', 'n matricule', 'numero matricule', 'mat', 'identifiant'],
    'nom_complet': ['noms et prenoms', 'nom et prenoms', 'nom et prenom', 'nom prenom', 'noms prenoms', 'eleve',
                    'eleves', 'nom de l eleve', 'noms des eleves', 'identite', 'noms', 'nom complet', 'apprenant',
                    'apprenants', 'candidat', 'student', 'name'],
    'nom': ['nom', 'nom de famille'],
    'prenom': ['prenom', 'prenoms'],
    'note': ['note', 'notes', 'note sur 20', 'note 20', 'valeur', 'points', 'note obtenue', 'mark', 'marks',
             'evaluation', 'devoir', 'composition', 'controle'],
    # Pseudo-champs : aident à repérer l'en-tête d'un relevé de notes.
    'sexe': ['sexe', 's', 'genre'],
    'appreciation': ['appreciation', 'appreciations', 'observation', 'observations', 'mention', 'rang'],
}

_ABSENT = {'abs', 'absent', 'absente', 'absence', 'ab', 'a', 'abst'}
_SEQ_ENTETE = (
    re.compile(r'^(?:seq(?:uence)?s?|s|eval(?:uation)?|ev|n|note|notes|devoir|ds|compo(?:sition)?|controle|mark)\s*(\d{1,2})$'),
    re.compile(r'^(\d{1,2})\s*(?:e|er|ere|eme|re|nd|nde)?\s*(?:seq(?:uence)?|eval(?:uation)?|devoir|composition|ds)$'),
)


def numero_sequence_entete(entete):
    """« Séq 1 », « S2 », « 3ème séquence », « Eval 4 » -> 1, 2, 3, 4 ; sinon None."""
    n = normaliser(entete)
    n = re.sub(r'^([a-z]+)(\d)', r'\1 \2', n)
    for motif in _SEQ_ENTETE:
        m = motif.match(n)
        if m:
            return int(m.group(1))
    return None


def _profil(valeurs):
    vals = [v for v in valeurs if v][:200]
    if not vals:
        return {}
    total = len(vals)
    scores = {}
    entiers = [entier(v) for v in vals]
    if all(e is not None for e in entiers) and total >= 3 \
            and sum(1 for a, b in zip(entiers, entiers[1:]) if b == a + 1) >= 0.7 * (total - 1):
        return {'numero': 0.95}
    if sum(1 for v in vals if parser_note(v, 20)[0] in ('note', 'absent')) >= 0.8 * total:
        scores['note'] = 0.6
    if sum(1 for v in vals if re.search(r'\d', v) and re.fullmatch(r'[A-Za-z0-9\-/]{5,20}', v)) >= 0.8 * total \
            and len(set(vals)) == total:
        scores['matricule'] = 0.6
    if sum(1 for v in vals if not re.search(r'\d', v) and len(v.split()) >= 2) >= 0.8 * total:
        scores['nom_complet'] = 0.55
    return scores


def _scores_sequences(cle, col):
    if numero_sequence_entete(cle) is not None and not re.fullmatch(r'colonne \d+', cle):
        return {'note_sequence': 0.9}
    return {}


SCHEMA = Schema(CHAMPS, SYNONYMES, profil=_profil, multiples=('note_sequence',),
                combines=[('nom_complet', ('nom', 'prenom'))],
                mot_cle_extra=lambda texte: numero_sequence_entete(texte) is not None)


def est_releve_notes(bloc):
    entetes = [normaliser(e) for e in bloc['entetes']]
    a_eleve = any(SCHEMA.score(c, e) >= 0.6 for e in entetes for c in ('nom_complet', 'nom', 'matricule'))
    a_note = any(SCHEMA.score('note', e) >= 0.6 or numero_sequence_entete(e) is not None for e in entetes)
    return a_eleve and a_note


def analyser_fichiers(fichiers, texte_colle=None):
    return analyser_avec_schema(fichiers, texte_colle, SCHEMA, pertinence=est_releve_notes)


def parser_note(texte, note_sur):
    """-> ('vide', None) | ('absent', None) | ('note', valeur sur 20) | ('erreur', message)."""
    t = (texte or '').strip()
    if not t or t in ('-', '—', '/'):
        return 'vide', None
    if normaliser(t) in _ABSENT:
        return 'absent', None
    m = re.fullmatch(r'(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:/\s*(\d{1,3}))?', t)
    if not m:
        return 'erreur', f"Note illisible « {t} »"
    valeur = float(m.group(1).replace(',', '.'))
    sur = int(m.group(2)) if m.group(2) else note_sur
    if not sur:
        return 'erreur', f"Note illisible « {t} »"
    if valeur > sur:
        return 'erreur', f"Note « {t} » supérieure au maximum ({sur})"
    return 'note', round(valeur * 20 / sur, 2)


# ---------------------------------------------------------------------------
# Traitement
# ---------------------------------------------------------------------------

def _vers_id(valeur, valides):
    try:
        v = int(valeur)
    except (TypeError, ValueError):
        return None
    return v if v in valides else None


def _options(brutes):
    o = dict(brutes or {})
    sur = entier(o.get('note_sur'))
    return {
        'matiere_classe_id': o.get('matiere_classe_id'),
        'sequence_id': o.get('sequence_id'),
        'note_sur': sur if sur and 1 <= sur <= 100 else 20,
        'doublons': 'mettre_a_jour' if o.get('doublons') == 'mettre_a_jour' else 'ignorer',
    }


def _numero_sequence(sequence, rang):
    chiffres = re.findall(r'\d+', sequence.libelle or '')
    return int(chiffres[-1]) if chiffres else rang


def _libelle_note(absent, valeur):
    if absent:
        return 'absent'
    return f'{valeur:g}' if valeur is not None else '—'


def traiter(etablissement_id, payload, valider=False, contexte=None):
    erreur = valider_blocs(payload)
    if erreur:
        return {'erreur': erreur}, 400
    contexte = contexte or {}
    profil = resolve_enseignant_profil(contexte.get('user_id'))
    if profil is None:
        return {'erreur': "Aucun profil enseignant n'est relié à ce compte. "
                          "Contactez l'administration de votre établissement."}, 400
    blocs = payload['blocs']
    options = _options(payload.get('options'))
    exclues = set(payload.get('exclues') or [])

    mapping_suggere, colonnes = SCHEMA.suggerer(blocs, _scores_sequences)
    mapping = payload.get('mapping')
    if not isinstance(mapping, dict):
        mapping = mapping_suggere
    mapping = {cle: champ for cle, champ in mapping.items() if champ in SCHEMA.cles}
    for col in colonnes:
        col['champ'] = mapping.get(col['cle'], '')

    # --- Périmètre de l'enseignant -------------------------------------------
    mes_mc = (MatiereClasse.query
              .join(Classe, Classe.id == MatiereClasse.classe_id)
              .filter(MatiereClasse.id.in_(resolve_enseignant_matiere_classe_ids(profil.id) or {0}),
                      Classe.etablissement_id == etablissement_id)
              .all())
    mc_par_id = {mc.id: mc for mc in mes_mc}

    def libelle_mc(mc):
        return f"{_libelles_classe(mc.classe)[0]} · {mc.matiere.libelle}"

    mc = mc_par_id.get(_vers_id(options['matiere_classe_id'], mc_par_id)) \
        or (mes_mc[0] if len(mes_mc) == 1 else None)

    annee = annee_active(etablissement_id)
    sequences = (Sequence.query.join(Trimestre, Trimestre.id == Sequence.trimestre_id)
                 .filter(Trimestre.annee_scolaire_id == annee.id).order_by(Trimestre.id, Sequence.id).all()) if annee else []
    seq_par_id = {s.id: s for s in sequences}
    seq_par_numero = {}
    for rang, s in enumerate(sequences, start=1):
        seq_par_numero.setdefault(_numero_sequence(s, rang), s)
    sequence_choisie = seq_par_id.get(_vers_id(options['sequence_id'], seq_par_id))

    reponse = {
        'colonnes': colonnes,
        'mapping': mapping,
        'mapping_suggere': mapping_suggere,
        'champs': SCHEMA.description_champs(),
        'matieres_classe': sorted(({'id': m.id, 'libelle': libelle_mc(m)} for m in mes_mc), key=lambda x: x['libelle']),
        'sequences': [{'id': s.id, 'libelle': s.libelle} for s in sequences],
        'matiere_classe_id': mc.id if mc else None,
        'sequence_id': sequence_choisie.id if sequence_choisie else None,
        'eleves': [],
        'lignes': [],
        'resume': {'total': 0, 'nouveaux': 0, 'mises_a_jour': 0, 'existants': 0, 'erreurs': 0, 'exclus': 0,
                   'avertissements': 0},
    }
    if mc is None or annee is None:
        return reponse, 200

    # --- Élèves inscrits et notes déjà saisies --------------------------------
    inscriptions = (Inscription.query
                    .filter(Inscription.classe_id == mc.classe_id, Inscription.annee_scolaire_id == annee.id,
                            Inscription.statut.in_(STATUTS_INSCRIPTION_EN_COURS)).all())
    eleves = {e.id: e for e in Eleve.query.filter(Eleve.id.in_([i.eleve_id for i in inscriptions] or [0])).all()}
    roster = []
    for insc in inscriptions:
        e = eleves.get(insc.eleve_id)
        if e:
            roster.append({'id': insc.id, 'nom': e.nom, 'prenom': e.prenom, 'matricule': e.matricule,
                           'cle': _cle_identite(e.nom, e.prenom), 'jetons': set(normaliser(f'{e.nom} {e.prenom}').split())})
    roster.sort(key=lambda x: (x['nom'], x['prenom']))
    par_inscription = {x['id']: x for x in roster}
    par_matricule = {normaliser_matricule(x['matricule']): x for x in roster if x['matricule']}
    par_cle = defaultdict(list)
    for x in roster:
        par_cle[x['cle']].append(x)
    notes_existantes = {(n.inscription_id, n.sequence_id): n for n in
                        Note.query.filter(Note.matiere_classe_id == mc.id,
                                          Note.inscription_id.in_(list(par_inscription) or [0])).all()}

    def retrouver(v):
        """-> (élève du roster | None, avertissement | None)."""
        if v.get('inscription_id'):
            x = par_inscription.get(_vers_id(v['inscription_id'], par_inscription))
            if x:
                return x, None
        nom_fichier = v.get('nom_complet') or f"{v.get('nom', '')} {v.get('prenom', '')}".strip()
        if v.get('matricule'):
            x = par_matricule.get(normaliser_matricule(v['matricule']))
            if x:
                return x, None
        if not nom_fichier:
            return None, None
        cle = _cle_identite(nom_fichier, '')
        if len(par_cle.get(cle, [])) == 1:
            return par_cle[cle][0], None
        jetons = set(normaliser(nom_fichier).split())
        inclus = [x for x in roster if jetons and (jetons <= x['jetons'] or x['jetons'] <= jetons)]
        if len(inclus) == 1:
            return inclus[0], f"Rapproché de « {inclus[0]['nom']} {inclus[0]['prenom']} »"
        scores = sorted(((SequenceMatcher(None, cle, x['cle']).ratio(), x['id']) for x in roster), reverse=True)
        if scores and scores[0][0] >= 0.88 and (len(scores) == 1 or scores[1][0] < scores[0][0] - 0.05):
            x = par_inscription[scores[0][1]]
            return x, f"Rapproché de « {x['nom']} {x['prenom']} » (orthographe différente)"
        return None, None

    # --- Ligne par ligne ------------------------------------------------------
    resultats, sans_note = [], 0
    vus = {}
    colonnes_sans_sequence = set()
    for rid, source, v, multiples, _bloc in SCHEMA.lignes(blocs, mapping, payload.get('corrections'), ('inscription_id',)):
        brutes = []
        if v.get('note', '') != '' and 'note' in v:
            brutes.append((sequence_choisie, v['note'], 'Note'))
        for entete, valeur in multiples.get('note_sequence', []):
            numero = numero_sequence_entete(entete)
            sequence = seq_par_numero.get(numero)
            if sequence is None:
                colonnes_sans_sequence.add(entete)
                continue
            brutes.append((sequence, valeur, entete))
        identite = v.get('nom_complet') or f"{v.get('nom', '')} {v.get('prenom', '')}".strip()
        if not any(parser_note(val, options['note_sur'])[0] != 'vide' for _s, val, _e in brutes):
            if identite or v.get('matricule'):
                sans_note += 1
            continue

        r = {'id': rid, 'source': source, 'erreurs': [], 'avertissements': [], 'statut': 'nouveau',
             'inscription_id': None, 'notes': []}
        if rid in exclues:
            r['statut'] = 'exclu'
        eleve, alerte = retrouver(v)
        if eleve is None:
            r['erreurs'].append(f"Élève introuvable dans la classe : « {identite or v.get('matricule')} »"
                                if identite or v.get('matricule') else "Ni nom ni matricule")
        else:
            r['inscription_id'] = eleve['id']
            if alerte:
                r['avertissements'].append(alerte)
            if v.get('matricule') and eleve['matricule'] \
                    and normaliser_matricule(v['matricule']) != normaliser_matricule(eleve['matricule']):
                r['avertissements'].append(f"Matricule du fichier « {v['matricule']} » différent de « {eleve['matricule']} »")
            if r['statut'] != 'exclu':
                if eleve['id'] in vus:
                    r['erreurs'].append(f"Élève déjà présent plus haut ({vus[eleve['id']]})")
                else:
                    vus[eleve['id']] = source

        for sequence, valeur, entete in brutes:
            genre, resultat = parser_note(valeur, options['note_sur'])
            if genre == 'vide':
                continue
            n = {'sequence_id': sequence.id if sequence else None,
                 'sequence': sequence.libelle if sequence else entete, 'valeur': None, 'absent': False,
                 'statut': 'nouvelle', 'motif': ''}
            if sequence is None:
                r['erreurs'].append("Choisissez la séquence de la colonne « Note »")
                n['statut'] = 'ignoree'
            elif genre == 'erreur':
                r['erreurs'].append(resultat)
                n['statut'] = 'ignoree'
            else:
                n['absent'] = genre == 'absent'
                n['valeur'] = resultat
                existante = notes_existantes.get((eleve['id'], sequence.id)) if eleve else None
                if existante is not None:
                    ancienne = float(existante.valeur) if existante.valeur is not None else None
                    if bool(existante.absent) == n['absent'] and ancienne == n['valeur']:
                        n['statut'] = 'existe'
                    elif options['doublons'] == 'mettre_a_jour':
                        n['statut'] = 'maj'
                        n['motif'] = f"remplace {_libelle_note(existante.absent, ancienne)}"
                    else:
                        n['statut'] = 'existe'
                        n['motif'] = f"déjà saisie : {_libelle_note(existante.absent, ancienne)}, conservée"
                        r['avertissements'].append(f"{sequence.libelle} : note déjà saisie "
                                                   f"({_libelle_note(existante.absent, ancienne)}), conservée")
            r['notes'].append(n)

        if r['erreurs'] and r['statut'] != 'exclu':
            r['statut'] = 'erreur'
        elif r['statut'] != 'exclu':
            statuts = {n['statut'] for n in r['notes']}
            r['statut'] = 'nouveau' if 'nouvelle' in statuts else 'maj' if 'maj' in statuts else 'existant'
        r['donnees'] = {
            'eleve': f"{eleve['nom']} {eleve['prenom']}".strip() if eleve else identite,
            'matricule': (eleve['matricule'] if eleve else v.get('matricule', '')) or '',
            'fichier': identite,
        }
        resultats.append(r)

    if colonnes_sans_sequence:
        for r in resultats:
            if r['statut'] not in ('erreur', 'exclu'):
                r['avertissements'].append("Colonnes sans séquence correspondante ignorées : "
                                           + ', '.join(sorted(colonnes_sans_sequence)))
                break

    resume = Counter(r['statut'] for r in resultats)
    actifs = [r for r in resultats if r['statut'] in ('nouveau', 'maj')]
    toutes = [n for r in actifs for n in r['notes']]
    notes_par_eleve = {r['inscription_id'] for r in resultats if r['inscription_id'] and r['statut'] != 'exclu'}
    reponse.update({
        'eleves': [{'id': x['id'], 'libelle': f"{x['nom']} {x['prenom']}".strip()} for x in roster],
        'lignes': resultats,
        'resume': {
            'total': len(resultats),
            'nouveaux': resume['nouveau'], 'mises_a_jour': resume['maj'], 'existants': resume['existant'],
            'erreurs': resume['erreur'], 'exclus': resume['exclu'],
            'notes_nouvelles': sum(1 for n in toutes if n['statut'] == 'nouvelle'),
            'notes_maj': sum(1 for n in toutes if n['statut'] == 'maj'),
            'absents': sum(1 for n in toutes if n['statut'] in ('nouvelle', 'maj') and n['absent']),
            'lignes_sans_note': sans_note,
            'eleves_absents_du_fichier': len(roster) - len(notes_par_eleve),
            'effectif': len(roster),
            'avertissements': sum(1 for r in resultats if r['avertissements'] and r['statut'] not in ('erreur', 'exclu')),
        },
    })
    if not valider:
        return reponse, 200

    try:
        bilan = Counter()
        maintenant = datetime.utcnow()
        for r in actifs:
            for n in r['notes']:
                if n['statut'] == 'nouvelle':
                    db.session.add(Note(inscription_id=r['inscription_id'], matiere_classe_id=mc.id,
                                        sequence_id=n['sequence_id'], valeur=n['valeur'], absent=n['absent'],
                                        saisie_le=maintenant))
                    bilan['notes_creees'] += 1
                elif n['statut'] == 'maj':
                    note = notes_existantes[(r['inscription_id'], n['sequence_id'])]
                    note.valeur, note.absent, note.saisie_le = n['valeur'], n['absent'], maintenant
                    bilan['notes_mises_a_jour'] += 1
                else:
                    continue
                if n['absent']:
                    bilan['absences'] += 1
        db.session.commit()
    except Exception as exc:  # pragma: no cover - remonté proprement à l'utilisateur
        db.session.rollback()
        return {'erreur': f"L'import a échoué, rien n'a été enregistré : {exc}"}, 500
    reponse['bilan'] = dict(bilan)
    return reponse, 200


def generer_modele_xlsx():
    from services.import_modeles import modele_xlsx
    return modele_xlsx(
        'Notes',
        ['Matricule', 'Nom et prénoms', 'Séq 1', 'Séq 2'],
        [['250237775', 'ABALA MBOUNDA Joseph', 12.5, 'abs'], ['250237776', 'BELINGA Marie', 15, 9.75]],
        largeurs=(16, 34, 10, 10),
        aide=[
            "• Une ligne par élève. Le matricule suffit ; à défaut l'élève est retrouvé par son nom, dans n'importe quel ordre.",
            "• Une colonne par séquence (« Séq 1 », « Séq 2 »…), ou une seule colonne « Note » pour la séquence choisie à l'import.",
            "• Notes sur 20, virgule ou point acceptés. « abs » ou « absent » = élève absent. Case vide = pas de note.",
            "• Notes sur 10 ou sur 40 : choisissez le barème à l'import, ou écrivez « 12/40 » dans la case.",
            "• Vous importez dans la matière et la classe choisies à l'import : les élèves sont ceux inscrits dans cette classe.",
        ],
    )
