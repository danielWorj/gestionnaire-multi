/**
 * intercepteur.js — Couche HTTP bas niveau pour tous les appels à l'API
 * ─────────────────────────────────────────────────────────────────────────
 * Contrairement à auth.js, ce fichier ne prend AUCUNE décision de
 * navigation : il ne redirige jamais vers /login. Il se contente de :
 *   - envoyer les cookies (credentials: 'include')
 *   - attacher le header CSRF requis par flask-jwt-extended
 *   - retenter une fois la requête après un /refresh silencieux si le
 *     serveur répond 401 (access token expiré)
 *
 * C'est donc le fichier à inclure sur TOUTE page ou composant qui appelle
 * l'API, y compris des pages publiques ou des widgets qui ne doivent pas
 * forcer une redirection en cas d'échec (c'est décidé par l'appelant, ou par
 * auth.js pour les pages strictement protégées — voir requireAuth()).
 *
 * À inclure AVANT auth.js et avant tout script de page qui appelle l'API :
 *   <script src="/static/js/intercepteur.js"></script>
 *   <script src="/static/js/auth.js"></script>        <!-- si la page en a besoin -->
 *   <script src="/static/js/sidebar.js" defer></script>
 * ─────────────────────────────────────────────────────────────────────────
 */

(function (global) {
  "use strict";

  const API_BASE = "/api/auth";

  /* ── Lecture d'un cookie non-httpOnly (ex. cookie CSRF) ──────────────── */
  function getCookie(name) {
    const match = document.cookie.match(
      new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)")
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function getCsrfToken(kind) {
    // 'access' pour la quasi-totalité des appels, 'refresh' uniquement pour /refresh
    return getCookie(kind === "refresh" ? "csrf_refresh_token" : "csrf_access_token");
  }

  function needsCsrf(method) {
    return !["GET", "HEAD", "OPTIONS"].includes((method || "GET").toUpperCase());
  }

  /* ── Refresh dédupliqué ─────────────────────────────────────────────────
     Important avec la rotation de refresh token côté serveur : si deux
     requêtes tombent en 401 en même temps (ex. deux appels API en parallèle
     au chargement d'une page), il ne faut PAS déclencher deux /refresh
     concurrents. Le premier ferait tourner le refresh token, le second
     présenterait alors un cookie déjà périmé -> le serveur le prendrait pour
     une réutilisation suspecte et couperait toute la session. On mutualise
     donc l'appel de refresh en cours dans une seule promesse partagée. */
  let refreshEnCours = null;

  async function refreshAccessToken() {
    if (refreshEnCours) return refreshEnCours;

    refreshEnCours = (async () => {
      try {
        const csrf = getCsrfToken("refresh");
        const res = await fetch(`${API_BASE}/refresh`, {
          method: "POST",
          credentials: "include",
          headers: csrf ? { "X-CSRF-TOKEN": csrf } : {},
        });
        return res.ok;
      } catch (e) {
        return false;
      } finally {
        refreshEnCours = null;
      }
    })();

    return refreshEnCours;
  }

  /** fetch() authentifié générique : ajoute les cookies + CSRF, retente une
   *  fois après refresh en cas de 401. Ne redirige JAMAIS — retourne
   *  toujours la Response (éventuellement encore 401 si le refresh a
   *  échoué), à l'appelant de décider quoi en faire. */
  async function apiFetch(url, options) {
    options = Object.assign({}, options);
    options.credentials = "include";

    const doFetch = () => {
      const headers = Object.assign({}, options.headers);
      if (needsCsrf(options.method)) {
        const csrf = getCsrfToken("access");
        if (csrf) headers["X-CSRF-TOKEN"] = csrf;
      }
      return fetch(url, Object.assign({}, options, { headers }));
    };

    let res = await doFetch();

    if (res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        res = await doFetch();
      }
      // Si le refresh échoue, on renvoie la 401 telle quelle : c'est à
      // l'appelant (ex. auth.js pour une page protégée, ou un composant qui
      // affiche juste un message) de décider s'il redirige, affiche une
      // bannière, désactive un bouton, etc.
    }

    return res;
  }

  global.ApiIntercepteur = {
    API_BASE,
    apiFetch,
    refreshAccessToken,
    getCookie,
    getCsrfToken,
  };
})(window);