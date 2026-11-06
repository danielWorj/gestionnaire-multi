// Mode hors connexion (notes, discipline, inscriptions, paiements…) :
//  1. session locale : le compte reste ouvert 30 jours sans réseau ;
//  2. préchargement : à chaque connexion, les données dont le rôle a besoin
//     sont copiées sur l'appareil (cf. stockageLocal.js et le cache GET
//     d'api.js) ;
//  3. file d'attente : une saisie faite sans réseau est gardée sur l'appareil
//     puis envoyée automatiquement au retour de la connexion. Si la donnée a
//     changé sur le serveur entre-temps (ou existe déjà), rien n'est écrit :
//     l'utilisateur voit qui l'a modifiée et quand (journal d'audit), et
//     décide d'écraser ou d'ignorer (components/ConflitsSynchro.jsx).
import { useEffect, useState } from 'react';
import { api, apiRequest, cleCache, estHorsLigne } from './api';
import { majCacheListe, setProprietaireCache, viderCache } from './stockageLocal';

// ── 1. Session hors connexion (30 jours) ──────────────────────────────────
const SESSION_KEY = 'sessionHorsLigne';
export const DUREE_SESSION_HORS_LIGNE_MS = 30 * 24 * 60 * 60 * 1000;

// Propriétaire des données gardées sur l'appareil (copies locales et saisies
// en attente). Les ids SuperAdmin et Utilisateur se chevauchent (deux tables) :
// préfixe pour le SuperAdmin ; format inchangé pour les comptes
// d'établissement (leurs données déjà stockées restent les leurs).
export const idProprietaire = (compte) => {
  if (!compte || compte.id == null) return null;
  return compte.type === 'superadmin' ? `superadmin:${compte.id}` : compte.id;
};

// Appelé à chaque /auth/me réussi : la durée repart de la dernière
// connexion au serveur.
export function memoriserSession(user) {
  setProprietaireCache(idProprietaire(user));
  if (!user || user.type === 'superadmin') return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user, verifieLe: Date.now() }));
  } catch {
    // stockage indisponible : pas de session hors ligne
  }
}

export function lireSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!s?.user || Date.now() - s.verifieLe > DUREE_SESSION_HORS_LIGNE_MS) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    setProprietaireCache(idProprietaire(s.user));
    return s;
  } catch {
    return null;
  }
}

export function oublierSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(PRECHARGE_KEY);
  setProprietaireCache(null);
  viderCache();
}

// ── 2. État du réseau ─────────────────────────────────────────────────────
export function useEnLigne() {
  const [enLigne, setEnLigne] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const maj = () => setEnLigne(navigator.onLine);
    window.addEventListener('online', maj);
    window.addEventListener('offline', maj);
    return () => {
      window.removeEventListener('online', maj);
      window.removeEventListener('offline', maj);
    };
  }, []);
  return enLigne;
}

// ── 3. File d'attente des opérations (tous modules) ───────────────────────
// Une opération = une écriture à faire au serveur, gardée sur l'appareil tant
// qu'elle n'a pas abouti :
//   cle         identifiant de la donnée visée (une seule opération par donnée :
//               une nouvelle saisie remplace la précédente)
//   module      'notes', 'discipline'… (cf. modulesHorsLigne.js)
//   methode/url requête à faire ; body = valeurs saisies
//   versionBase version de la donnée vue au moment de la saisie (null : on
//               pensait la créer ; undefined : pas de contrôle de conflit)
//   libelle     description lisible (« Eleve Un — Maths · Séquence 1 »)
//   cache       chemin GET dont la copie locale doit refléter le résultat
//   conflit     réponse 409 du serveur, en attente de la décision de
//               l'utilisateur (écraser ou ignorer)
//   conserverSiRefus  (paiements) un refus du serveur à la synchronisation
//               ne fait pas disparaître la saisie : elle reste visible avec
//               le motif (`refus`) jusqu'à ce que l'utilisateur l'abandonne
const OPERATIONS_KEY = 'horsLigneOperations';
const ANCIENNES_NOTES_KEY = 'notesEnAttente';
// Émis à chaque changement de la file (pages, bandeau, écran des conflits).
export const ATTENTE_EVENT = 'horsLigne:attente';
// Émis après une synchronisation, detail = {
//   envoyees:  [{ op, resultat }]   écrites au serveur
//   ignorees:  [{ op, serveur }]    conflit tranché « ignorer » : valeur du serveur
//   refusees:  [{ op, message }]    refus définitif (droits, données invalides)
//   conflits:  [op]                 nouveaux conflits à trancher }
export const SYNCHRO_EVENT = 'horsLigne:synchronisee';

export const cleNote = (body) => `note|${body.inscription_id}|${body.matiere_classe_id}|${body.sequence_id}`;
export const cleDiscipline = (body) => `discipline|${body.inscription_id}|${body.sequence_id}`;

let utilisateurCourant = null;
export function setUtilisateurAttente(id) {
  utilisateurCourant = id == null ? null : String(id);
}

function ecrireTout(tout, notifier = true) {
  try {
    localStorage.setItem(OPERATIONS_KEY, JSON.stringify(tout));
  } catch {
    // stockage plein : l'opération reste affichée en attente
  }
  if (notifier) window.dispatchEvent(new Event(ATTENTE_EVENT));
}

// Notes en attente de l'ancienne version ({ 'i|m|s': body }) : reprises
// telles quelles, sans contrôle de conflit (comportement d'alors).
function migrerAnciennesNotes(tout) {
  let anciennes;
  try {
    anciennes = JSON.parse(localStorage.getItem(ANCIENNES_NOTES_KEY) || 'null');
  } catch {
    anciennes = null;
  }
  if (!anciennes) return false;
  Object.values(anciennes).forEach(({ _utilisateur, _saisieLe, ...body }) => {
    const cle = cleNote(body);
    if (!tout[cle]) {
      tout[cle] = {
        cle, module: 'notes', methode: 'POST', url: '/notes/', body, versionBase: undefined,
        libelle: 'Note saisie hors connexion', _utilisateur: _utilisateur ?? null, _saisieLe: _saisieLe || Date.now(),
      };
    }
  });
  localStorage.removeItem(ANCIENNES_NOTES_KEY);
  return true;
}

function lireTout() {
  let tout;
  try {
    tout = JSON.parse(localStorage.getItem(OPERATIONS_KEY) || '{}') || {};
  } catch {
    tout = {};
  }
  if (migrerAnciennesNotes(tout)) ecrireTout(tout, false);
  return tout;
}

// Opérations de l'utilisateur connecté (celles d'un autre compte du même
// appareil restent stockées et partiront à sa prochaine connexion).
export function lireAttente(module = null) {
  const res = {};
  Object.entries(lireTout()).forEach(([cle, op]) => {
    if ((!op._utilisateur || op._utilisateur === utilisateurCourant) && (!module || op.module === module)) res[cle] = op;
  });
  return res;
}

export function mettreEnAttente(op) {
  const tout = lireTout();
  const precedente = tout[op.cle];
  tout[op.cle] = {
    ...op,
    // Ressaisie d'une donnée déjà en attente : la version de référence reste
    // celle vue lors de la PREMIÈRE saisie (c'est elle que le serveur compare).
    versionBase: precedente && precedente.versionBase !== undefined ? precedente.versionBase : op.versionBase,
    conflit: undefined,
    refus: undefined,
    forcer: false,
    _utilisateur: utilisateurCourant,
    _saisieLe: Date.now(),
  };
  ecrireTout(tout);
}

// `envoyee` : ne retire que si la donnée n'a pas été ressaisie entre-temps.
export function retirerAttente(cle, envoyee = null) {
  const tout = lireTout();
  if (!tout[cle]) return;
  if (envoyee && tout[cle]._saisieLe !== envoyee._saisieLe) return;
  delete tout[cle];
  ecrireTout(tout);
}

function majOperation(cle, maj) {
  const tout = lireTout();
  if (!tout[cle]) return;
  tout[cle] = { ...tout[cle], ...maj };
  ecrireTout(tout);
}

export function useOperationsEnAttente(module = null) {
  const [attente, setAttente] = useState(() => lireAttente(module));
  useEffect(() => {
    const maj = () => setAttente(lireAttente(module));
    window.addEventListener(ATTENTE_EVENT, maj);
    window.addEventListener('storage', maj); // autre onglet
    return () => {
      window.removeEventListener(ATTENTE_EVENT, maj);
      window.removeEventListener('storage', maj);
    };
  }, [module]);
  return attente;
}

// Erreurs pour lesquelles on garde l'opération et on réessaiera plus tard :
// réseau, serveur indisponible, ou session à renouveler (reconnexion).
export const estARessayer = (e) => estHorsLigne(e) || e?.status === 401;
const estConflit = (e) => e?.status === 409 && ['conflit', 'doublon'].includes(e.payload?.code);

function notifierSynchro(detail) {
  const d = { envoyees: [], ignorees: [], refusees: [], conflits: [], ...detail };
  if (d.envoyees.length || d.ignorees.length || d.refusees.length || d.conflits.length) {
    window.dispatchEvent(new CustomEvent(SYNCHRO_EVENT, { detail: d }));
  }
}

// Envoie une opération ; ne touche pas à la file.
async function envoyer(op, { horsLigne }) {
  const body = { ...op.body };
  if (op.versionBase !== undefined) body.version_base = op.versionBase;
  if (op.forcer) body.forcer = true;
  const headers = horsLigne ? { 'X-Saisi-Hors-Ligne-Le': new Date(op._saisieLe || Date.now()).toISOString() } : undefined;
  const resultat = await api.envoyer(op.methode, op.url, body, headers);
  if (op.cache && resultat) await majCacheListe(cleCache(op.cache), resultat);
  return resultat;
}

function marquerConflit(cle, erreur) {
  majOperation(cle, { conflit: { ...erreur.payload, detecteLe: Date.now() } });
  return lireAttente()[cle];
}

// Enregistrement « en direct » depuis une page : envoie tout de suite si
// possible, sinon garde l'opération (réseau absent) ou la soumet à
// l'utilisateur (conflit). Retourne { statut: 'ok' | 'attente' | 'conflit' |
// 'refus', resultat?, message? }.
export async function enregistrer(op) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    mettreEnAttente(op);
    return { statut: 'attente' };
  }
  try {
    const resultat = await envoyer(op, { horsLigne: false });
    retirerAttente(op.cle);
    return { statut: 'ok', resultat };
  } catch (e) {
    if (estARessayer(e)) {
      mettreEnAttente(op);
      return { statut: 'attente' };
    }
    if (estConflit(e)) {
      mettreEnAttente(op);
      notifierSynchro({ conflits: [marquerConflit(op.cle, e)] });
      return { statut: 'conflit' };
    }
    retirerAttente(op.cle);
    return { statut: 'refus', message: e.message };
  }
}

let synchroEnCours = null;

// Envoie toutes les opérations en attente de l'utilisateur, une à une et dans
// l'ordre de saisie (connexion qui revient à peine), sauf celles dont le
// conflit attend une décision. S'arrête au premier échec réseau.
export function synchroniser() {
  if (!synchroEnCours) {
    synchroEnCours = (async () => {
      const envoyees = [];
      const refusees = [];
      const conflits = [];
      const ops = Object.values(lireAttente()).filter((op) => !op.conflit && !op.refus).sort((a, b) => a._saisieLe - b._saisieLe);
      for (const op of ops) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const resultat = await envoyer(op, { horsLigne: true });
          retirerAttente(op.cle, op);
          envoyees.push({ op, resultat });
        } catch (e) {
          if (estARessayer(e)) break;
          if (estConflit(e)) {
            conflits.push(marquerConflit(op.cle, e));
            continue;
          }
          // Refus définitif (matière retirée, élève désinscrit, reste dû
          // dépassé…) : retiré, sauf saisie à conserver (paiement).
          if (op.conserverSiRefus) majOperation(op.cle, { refus: { message: e.message, le: Date.now() } });
          else retirerAttente(op.cle, op);
          refusees.push({ op, message: e.message, conservee: Boolean(op.conserverSiRefus) });
        }
      }
      notifierSynchro({ envoyees, refusees, conflits });
      const restantes = Object.values(lireAttente());
      return {
        envoyees, refusees, conflits,
        restantes: restantes.length,
        enConflit: restantes.filter((o) => o.conflit).length,
        refuseesConservees: restantes.filter((o) => o.refus).length,
      };
    })().finally(() => {
      synchroEnCours = null;
    });
  }
  return synchroEnCours;
}

// Décision de l'utilisateur sur un conflit :
//  'ecraser' : sa saisie remplace celle du serveur (renvoyée avec forcer) ;
//  'ignorer' : sa saisie est abandonnée, la valeur du serveur est conservée.
export async function resoudreConflit(cle, choix) {
  const op = lireAttente()[cle];
  if (!op?.conflit) return null;
  if (choix === 'ignorer') {
    retirerAttente(cle);
    const serveur = op.conflit.serveur;
    if (op.cache && serveur) await majCacheListe(cleCache(op.cache), serveur);
    notifierSynchro({ ignorees: [{ op, serveur }] });
    return { statut: 'ignoree' };
  }
  majOperation(cle, { conflit: undefined, forcer: true });
  return synchroniser();
}

// Saisie refusée puis corrigée côté serveur (ex. échéancier modifié) :
// nouvelle tentative d'envoi.
export function reessayer(cle) {
  majOperation(cle, { refus: undefined });
  return synchroniser();
}

// ── 4. Préchargement des données (selon le rôle) ──────────────────────────
// À chaque connexion (au plus toutes les 10 min, ou tout de suite après un
// envoi), les données dont le rôle a besoin hors connexion sont recopiées
// sur l'appareil. Les URL sont écrites EXACTEMENT comme dans les pages
// (useNotesContexte, HorairePage…) : ce sont les clés du cache.
const PRECHARGE_KEY = 'horsLigneDernierPrechargement';
const INTERVALLE_PRECHARGEMENT_MS = 10 * 60 * 1000;
export const PRECHARGE_EVENT = 'horsLigne:precharge';

export function dateDernierPrechargement() {
  const v = Number(localStorage.getItem(PRECHARGE_KEY));
  return v || null;
}

let prechargementEnCours = null;
const charger = (path) => (path ? apiRequest(path, { sansCopieLocale: true }) : null);
const anneeActive = (annees) => (annees.find((a) => a.active) || annees[0])?.id;

// Une classe après l'autre : ne pas saturer une connexion faible.
async function parClasse(classes, chemins) {
  for (const classeId of classes) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.allSettled(chemins(classeId).map(charger));
  }
}

// Emploi du temps de l'établissement (HorairePage, en consultation).
const EMPLOI_DU_TEMPS = ['/annees-scolaires/', '/cycles/', '/classes/', '/enseignants/', '/matieres/',
  '/creneaux-horaires/', '/matieres-classe/', '/horaires/'];

async function espaceEnseignant() {
  const espace = await charger('/enseignant/mon-espace');
  const annee = anneeActive(espace?.annees_scolaires || []);
  await Promise.allSettled([
    charger(annee && `/enseignant/sequences?annee_scolaire_id=${annee}`),
    charger(annee && `/enseignant/horaire?annee_scolaire_id=${annee}`),
  ]);
  const classes = [...new Set((espace?.matieres_classe || []).map((m) => m.classe_id))];
  await parClasse(classes, (c) => [annee && `/enseignant/roster?classe_id=${c}&annee_scolaire_id=${annee}`, `/notes/?classe_id=${c}`]);
}

// Censeur / Surveillant : notes (consultation), discipline (saisie),
// emploi du temps (consultation) de leurs classes.
async function espaceEncadrement() {
  const espace = await charger('/censeur/mon-espace');
  const annee = anneeActive(espace?.annees_scolaires || []);
  await Promise.allSettled([charger(annee && `/censeur/sequences?annee_scolaire_id=${annee}`), ...EMPLOI_DU_TEMPS.map(charger)]);
  const classes = (espace?.classes || []).map((c) => c.id);
  await parClasse(classes, (c) => [
    annee && `/censeur/roster?classe_id=${c}&annee_scolaire_id=${annee}`, `/notes/?classe_id=${c}`, `/disciplines/?classe_id=${c}`,
  ]);
}

// Secrétariat / comptabilité / administration : listes complètes de
// l'établissement (pages Élèves, Parents, Inscriptions, Paiements).
const SCOLARITE = ['/inscriptions/', '/eleves/', '/parents/', '/classes/', '/cycles/', '/annees-scolaires/'];
const FINANCES = ['/tranches-classe/', '/paiements/'];
const listes = (chemins) => async () => {
  // Deux à deux : ce sont de grosses listes, la connexion peut être faible.
  for (let i = 0; i < chemins.length; i += 2) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.allSettled(chemins.slice(i, i + 2).map(charger));
  }
};

const RECETTES = {
  Enseignant: espaceEnseignant,
  Censeur: espaceEncadrement,
  Surveillant: espaceEncadrement,
  Secretaire: listes(SCOLARITE),
  Comptable: listes([...SCOLARITE, ...FINANCES]),
  Admin: listes([...new Set([...SCOLARITE, ...FINANCES, ...EMPLOI_DU_TEMPS])]),
};

export const rolePrecharge = (role) => Boolean(RECETTES[role]);

export function prechargerEspace(role, { force = false } = {}) {
  const recette = RECETTES[role];
  if (!recette) return Promise.resolve(false);
  if (prechargementEnCours) return prechargementEnCours;
  const dernier = dateDernierPrechargement();
  if (!force && dernier && Date.now() - dernier < INTERVALLE_PRECHARGEMENT_MS) return Promise.resolve(false);
  prechargementEnCours = recette()
    .then(() => {
      localStorage.setItem(PRECHARGE_KEY, String(Date.now()));
      window.dispatchEvent(new Event(PRECHARGE_EVENT));
      return true;
    })
    .catch(() => false)
    .finally(() => {
      prechargementEnCours = null;
    });
  return prechargementEnCours;
}

// ── 5. Aides pour les pages ───────────────────────────────────────────────
// Clé d'une CRÉATION (la donnée n'a pas encore d'identifiant serveur).
export const nouvelleCle = (prefixe) => `${prefixe}|${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Recharge une page quand des saisies de ses modules ont été synchronisées
// (envoyées, ou conflit tranché en faveur du serveur).
export function useApresSynchro(modules, rappel) {
  const cle = modules.join(',');
  useEffect(() => {
    const liste = cle.split(',');
    const onSynchro = (e) => {
      const { envoyees, ignorees } = e.detail;
      if ([...envoyees, ...ignorees].some((x) => liste.includes(x.op.module))) rappel();
    };
    window.addEventListener(SYNCHRO_EVENT, onSynchro);
    return () => window.removeEventListener(SYNCHRO_EVENT, onSynchro);
  }, [cle, rappel]);
}

// Suite commune d'un formulaire après enregistrer() : fermeture + message
// adapté (enregistré / gardé sur l'appareil / à trancher), ou erreur levée.
export async function terminerEnregistrement(res, { onSaved, ok }) {
  if (res.statut === 'ok') return onSaved(ok);
  if (res.statut === 'attente') return onSaved(`${ok} — gardé sur cet appareil, envoi automatique au retour de la connexion.`);
  if (res.statut === 'conflit') return onSaved('Doublon ou modification concurrente détecté : choisissez la version à garder.');
  throw new Error(res.message);
}
