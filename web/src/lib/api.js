// Par défaut '/api' (même origine, via le proxy Vite — cf. vite.config.js) :
// les cookies JWT/CSRF sont alors posés sur l'origine du front, quel que soit
// l'hôte utilisé (localhost ou 127.0.0.1). Avec une URL absolue vers un autre
// hôte, le cookie CSRF devient illisible par document.cookie et SameSite=Lax
// bloque l'envoi des cookies.
const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

const COLLECTION_ENDPOINTS = new Set([
  '/etablissements',
  '/cycles',
  '/annees-scolaires',
  '/trimestres',
  '/sequences',
  '/matieres',
  '/enseignants',
  '/classes',
  '/eleves',
  '/parents',
  '/inscriptions',
  '/paiements',
  '/groupes-matieres',
  '/departements',
  '/grades',
  '/censeurs',
  '/surveillants',
  '/titulaires-classe',
  '/matieres-classe',
]);

const NO_TRAILING_SLASH_PATHS = new Set([
  '/auth/login',
  '/auth/logout',
  '/auth/refresh',
  '/auth/me',
  '/auth/change-password',
  '/auth/choisir-role',
  '/auth/utilisateurs',
  '/auth/roles',
  '/health',
]);

function normalizeApiPath(path) {
  if (!path || path === '/') {
    return '/';
  }

  const nextPath = path.startsWith('/') ? path : `/${path}`;
  const [basePath, queryString = ''] = nextPath.split('?');
  const normalizedBase = basePath.replace(/\/+$/, '');

  if (NO_TRAILING_SLASH_PATHS.has(normalizedBase) || /\/[0-9]+$/.test(normalizedBase)) {
    return queryString ? `${normalizedBase}?${queryString}` : normalizedBase;
  }

  // Slash final écrit explicitement par l'appelant (route Flask « /xxx/ ») : conservé.
  if (COLLECTION_ENDPOINTS.has(normalizedBase) || basePath.endsWith('/')) {
    const finalBase = `${normalizedBase}/`;
    return queryString ? `${finalBase}?${queryString}` : finalBase;
  }

  return queryString ? `${normalizedBase}?${queryString}` : normalizedBase;
}

// Requêtes pour lesquelles un 401 ne doit PAS déclencher de /auth/refresh.
const NO_REFRESH_PATHS = new Set(['/auth/login', '/auth/superadmin/login', '/auth/refresh', '/auth/logout']);

const CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getCookie(name) {
  const match = document.cookie.split('; ').find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function buildUrl(normalizedPath) {
  return normalizedPath.startsWith('http') ? normalizedPath : `${API_BASE}${normalizedPath}`;
}

// Les JWT sont en cookies httpOnly avec protection CSRF (double-submit) :
// flask-jwt-extended exige le header X-CSRF-TOKEN = cookie csrf_access_token
// (ou csrf_refresh_token pour /refresh) sur toute requête d'écriture, sinon 401.
function send(normalizedPath, options, csrfCookie = 'csrf_access_token') {
  const headers = new Headers(options.headers || {});

  if (!(options.body instanceof FormData) && !headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  const method = (options.method || 'GET').toUpperCase();
  if (CSRF_METHODS.has(method)) {
    const csrf = getCookie(csrfCookie);
    if (csrf) {
      headers.set('X-CSRF-TOKEN', csrf);
    }
  }

  return fetch(buildUrl(normalizedPath), { ...options, credentials: 'include', headers });
}

// Refresh dédupliqué : le serveur fait tourner le refresh token à chaque
// appel et révoque la session s'il voit un ancien token réutilisé. Deux
// /refresh concurrents (requêtes parallèles du dashboard, double montage
// StrictMode) déconnecteraient donc l'utilisateur : on partage une promesse.
let refreshInFlight = null;

export function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = send('/auth/refresh', { method: 'POST' }, 'csrf_refresh_token')
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

// Émis quand le serveur signale que le rôle actif de la session a été retiré
// (403 'role_revoque', cf. enforce_role_actif) : AuthContext relit le compte.
export const ROLE_REVOQUE_EVENT = 'auth:role-revoque';

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

// Établissement de contexte du SuperAdmin (compte global, sans établissement
// propre). Les listes « scopées » de l'API (/classes, /eleves, /matieres...)
// exigent alors ?etablissement_id=<id>, sinon 400 "etablissement_id requis".
// Reste null pour un utilisateur d'établissement : le serveur lit son
// établissement dans le JWT.
let activeEtablissementId = null;

export function setActiveEtablissementId(id) {
  activeEtablissementId = id ? Number(id) : null;
}

export function getActiveEtablissementId() {
  return activeEtablissementId;
}

// Appliqué à toutes les méthodes : les blueprints cloisonnés lisent aussi
// ?etablissement_id= sur PUT/DELETE quand l'appelant est SuperAdmin.
function withEtablissementScope(normalizedPath) {
  if (!activeEtablissementId || normalizedPath.startsWith('http')) {
    return normalizedPath;
  }
  const [basePath, query = ''] = normalizedPath.split('?');
  if (basePath.startsWith('/auth') || basePath.startsWith('/etablissements') || /(^|&)etablissement_id=/.test(query)) {
    return normalizedPath;
  }
  const params = new URLSearchParams(query);
  params.set('etablissement_id', String(activeEtablissementId));
  return `${basePath}?${params.toString()}`;
}

async function sendOrExplain(normalizedPath, options, csrfCookie) {
  try {
    return await send(normalizedPath, options, csrfCookie);
  } catch {
    // fetch() ne rejette que sur erreur réseau ou CORS (« Failed to fetch »).
    throw new ApiError('Impossible de joindre le serveur. Vérifiez que l’API est démarrée et accessible.', 0, null);
  }
}

export async function apiRequest(path, { responseType, ...options } = {}) {
  const normalizedPath = withEtablissementScope(normalizeApiPath(path));
  const basePath = normalizedPath.split('?')[0];

  let response = await sendOrExplain(normalizedPath, options);

  if (response.status === 401 && !NO_REFRESH_PATHS.has(basePath)) {
    if (await refreshSession()) {
      response = await sendOrExplain(normalizedPath, options);
    }
  }

  const contentType = response.headers.get('content-type') || '';
  // responseType 'blob' (PDF…) : corps binaire en cas de succès, erreur JSON sinon.
  const payload = responseType === 'blob' && response.ok ? await response.blob()
    : contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    if (response.status === 403 && payload?.code === 'role_revoque') {
      window.dispatchEvent(new Event(ROLE_REVOQUE_EVENT));
    }
    const message = typeof payload === 'object' && payload !== null
      ? payload.erreur || payload.error || payload.message || payload.msg || 'La requête a échoué.'
      : String(payload || 'La requête a échoué.');
    throw new ApiError(message, response.status, payload);
  }

  if (response.status === 204) {
    return null;
  }

  return payload;
}

// Raccourcis JSON. En POST, le SuperAdmin doit fournir etablissement_id dans
// le corps (les blueprints cloisonnés ne le lisent pas en query sur create) :
// on l'ajoute s'il manque. Sans effet pour un compte d'établissement.
function withEtablissementBody(body) {
  if (!activeEtablissementId || !body || typeof body !== 'object' || Array.isArray(body) || 'etablissement_id' in body) {
    return body;
  }
  return { ...body, etablissement_id: activeEtablissementId };
}

export const api = {
  get: (path) => apiRequest(path),
  post: (path, body) => apiRequest(path, { method: 'POST', body: JSON.stringify(withEtablissementBody(body ?? {})) }),
  put: (path, body) => apiRequest(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: (path, body) => apiRequest(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: (path) => apiRequest(path, { method: 'DELETE' }),
  blob: (path) => apiRequest(path, { responseType: 'blob' }),
};

export { API_BASE };
