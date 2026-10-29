/**
 * auth.js — Gestion de la session (Gestionnaire SaaS Bulletins de Notes)
 * ─────────────────────────────────────────────────────────────────────────
 * S'appuie sur intercepteur.js (window.ApiIntercepteur) pour le transport
 * HTTP bas niveau (cookies, CSRF, retry après refresh). Ce fichier n'ajoute
 * que la couche "session utilisateur" :
 *   - cache d'affichage non sensible (nom, rôle, etablissement_id)
 *   - requireAuth() / logout() : les DEUX SEULES fonctions qui redirigent
 *     vers /login. Rien dans intercepteur.js ne le fait.
 *
 * N'incluez ce fichier QUE sur les pages qui doivent être protégées (qui
 * appellent requireAuth() au chargement). Une page publique, un widget, ou
 * la page /login elle-même n'ont besoin que de intercepteur.js — inclure
 * auth.js dessus n'a pas d'effet de bord tant que requireAuth()/logout() ne
 * sont pas appelés explicitement, mais il est plus simple de ne charger que
 * ce dont chaque page a réellement besoin.
 *
 * À inclure APRÈS intercepteur.js, AVANT sidebar.js :
 *   <script src="/static/js/intercepteur.js"></script>
 *   <script src="/static/js/auth.js"></script>
 *   <script src="/static/js/sidebar.js" defer></script>
 * ─────────────────────────────────────────────────────────────────────────
 */

(function (global) {
  "use strict";

  if (!global.ApiIntercepteur) {
    throw new Error("auth.js requiert intercepteur.js — inclure intercepteur.js avant auth.js");
  }

  const { API_BASE, apiFetch } = global.ApiIntercepteur;
  const USER_CACHE_KEY = "gestionnaire_user_cache"; // affichage uniquement, non sensible

  /* ── Cache d'affichage (non sensible) ──────────────────────────────────
     L'autorisation réelle est TOUJOURS vérifiée côté serveur à chaque
     requête ; ce cache n'a aucune valeur de sécurité, seulement de confort
     d'affichage (éviter un flash "non connecté" pendant un aller-retour /me). */
  function setUserCache(user) {
    try {
      sessionStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    } catch (e) {
      /* stockage indisponible : tant pis, l'UI appellera /me un peu plus souvent */
    }
  }

  function getUser() {
    try {
      return JSON.parse(sessionStorage.getItem(USER_CACHE_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function clearUserCache() {
    sessionStorage.removeItem(USER_CACHE_KEY);
  }

  function getRole() {
    const user = getUser();
    return user && user.role ? user.role.libelle : null;
  }

  function getEtablissementId() {
    const user = getUser();
    return user ? user.etablissement_id : null;
  }

  /** Vérifie la session auprès du serveur (source de vérité) et met à jour
   *  le cache d'affichage. Ne redirige pas elle-même : renvoie null si la
   *  session n'est pas valide, à l'appelant de décider (voir requireAuth). */
  async function checkSession() {
    try {
      const res = await apiFetch(`${API_BASE}/me`, { method: "GET" });
      if (!res.ok) {
        clearUserCache();
        return null;
      }
      const user = await res.json();
      setUserCache(user);
      return user;
    } catch (e) {
      return null;
    }
  }

  /** À appeler en haut des pages protégées : redirige vers /login si la
   *  session n'est pas valide côté serveur. C'est la SEULE fonction de ce
   *  fichier qui déclenche une redirection automatique. */
  async function requireAuth() {
    const user = await checkSession();
    if (!user) {
      window.location.href = "/login";
      return false;
    }
    return true;
  }

  /** Déconnexion explicite (clic sur un bouton "Se déconnecter") : révoque
   *  la session côté serveur puis redirige. Contrairement à requireAuth(),
   *  la redirection ici est le résultat d'une action volontaire de
   *  l'utilisateur, pas d'un échec de vérification. */
  async function logout() {
    try {
      await apiFetch(`${API_BASE}/logout`, { method: "POST" });
    } catch (e) {
      /* on nettoie côté client même si l'appel réseau échoue */
    } finally {
      clearUserCache();
      window.location.href = "/login";
    }
  }

  global.GestionnaireAuth = {
    API_BASE,
    getUser,
    getRole,
    getEtablissementId,
    setUserCache,
    clearUserCache,
    checkSession,
    requireAuth,
    logout,
    // Exposé pour compatibilité : le code de page qui appelait
    // GestionnaireAuth.authFetch(...) continue de fonctionner sans
    // redirection automatique cachée (c'est le même apiFetch que
    // window.ApiIntercepteur.apiFetch).
    authFetch: apiFetch,
  };
})(window);