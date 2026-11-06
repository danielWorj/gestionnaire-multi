// Stockage local des données pour le mode hors connexion (IndexedDB : bien
// plus de place que localStorage, utile pour les notes de toutes les classes).
//
// Les réponses GET utiles à la saisie des notes y sont copiées à chaque
// succès ; si le réseau manque, api.js sert cette copie (éventuellement
// ancienne). Les entrées sont préfixées par l'utilisateur : deux comptes sur
// le même appareil ne voient jamais les données l'un de l'autre.

const DB_NOM = 'gestionnaire-hors-ligne';
const STORE = 'reponses';

let dbPromesse = null;

function ouvrir() {
  if (!dbPromesse) {
    dbPromesse = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB indisponible'));
        return;
      }
      const req = indexedDB.open(DB_NOM, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => {
      dbPromesse = null;
      throw e;
    });
  }
  return dbPromesse;
}

async function transaction(mode, operation) {
  const db = await ouvrir();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = operation(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Propriétaire des données en cache (id de l'utilisateur connecté), fixé par
// AuthContext. Sans propriétaire, rien n'est lu ni écrit.
let proprietaire = null;

export function setProprietaireCache(id) {
  proprietaire = id == null ? null : String(id);
}

// GET mis en cache : toutes les données métier (espaces, notes, discipline,
// emplois du temps, élèves, inscriptions, paiements…), sauf l'authentification
// (session gérée à part, cf. offline.js), le journal d'audit et les imports.
const PREFIXES_EXCLUS = ['/auth/', '/audit/', '/import', '/health', '/superadmin/'];

export function estCacheable(basePath) {
  return !PREFIXES_EXCLUS.some((p) => basePath.startsWith(p));
}

export async function lireCache(chemin) {
  if (!proprietaire) return null;
  try {
    return (await transaction('readonly', (s) => s.get(`${proprietaire}|${chemin}`))) || null;
  } catch {
    return null;
  }
}

export async function ecrireCache(chemin, data) {
  if (!proprietaire) return;
  try {
    await transaction('readwrite', (s) => s.put({ data, enregistreLe: Date.now() }, `${proprietaire}|${chemin}`));
  } catch {
    // Stockage plein ou indisponible (navigation privée) : on continue sans.
  }
}

// Reporte dans la copie locale d'une liste (ex. notes d'une classe) un
// élément écrit au serveur : remplacé s'il y est déjà (même id), ajouté
// sinon. Évite qu'une ouverture hors connexion ultérieure montre une
// ancienne version — et provoque un faux conflit avec soi-même.
export async function majCacheListe(chemin, element) {
  if (!proprietaire || !element || element.id == null) return;
  const copie = await lireCache(chemin);
  if (!copie || !Array.isArray(copie.data)) return;
  const liste = [...copie.data];
  const i = liste.findIndex((x) => x?.id === element.id);
  if (i < 0) liste.push(element);
  else liste[i] = element;
  try {
    await transaction('readwrite', (s) => s.put({ data: liste, enregistreLe: copie.enregistreLe }, `${proprietaire}|${chemin}`));
  } catch {
    // copie locale non mise à jour : elle le sera au prochain préchargement
  }
}

export async function viderCache() {
  try {
    await transaction('readwrite', (s) => s.clear());
  } catch {
    // rien à vider
  }
}
