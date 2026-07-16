/**
 * auth-admin.js — Gestion de la session SuperAdmin (Gestionnaire SaaS Bulletins de Notes)
 * ─────────────────────────────────────────────────────────────────────────
 * Équivalent de auth.js, mais pour l'espace d'administration globale de la
 * plateforme (/superadmin/*), qui a ses propres routes d'authentification
 * (/api/auth/superadmin/login, /me, /logout, /refresh) — un SuperAdmin n'est
 * PAS un Utilisateur, les deux espaces sont volontairement séparés côté API
 * (voir authentification_api.py : blueprint superadmin_bp).
 *
 * S'appuie sur intercepteur.js (window.ApiIntercepteur) pour le transport
 * HTTP bas niveau (cookies, CSRF, retry après refresh) — c'est le MÊME
 * intercepteur que pour l'espace établissement, les cookies JWT étant scopés
 * par path (JWT_ACCESS_COOKIE_PATH="/api/"), pas par blueprint.
 *
 * requireAuth() / logout() sont les DEUX SEULES fonctions qui redirigent
 * (vers /superadmin/login), au même titre que dans auth.js.
 *
 * À inclure APRÈS intercepteur.js, AVANT tout script de page (sidebar_admin.js) :
 *   <script src="/static/js/intercepteur.js"></script>
 *   <script src="/static/js/auth-admin.js"></script>
 *   <script src="/static/js/sidebar_admin.js" defer></script>
 * ─────────────────────────────────────────────────────────────────────────
 */

(function (global) {
  "use strict";

  if (!global.ApiIntercepteur) {
    throw new Error("auth-admin.js requiert intercepteur.js — inclure intercepteur.js avant auth-admin.js");
  }

  const { apiFetch } = global.ApiIntercepteur;
  const API_BASE = "/api/auth/superadmin";
  const USER_CACHE_KEY = "gestionnaire_superadmin_cache"; // affichage uniquement, non sensible
  const LOGIN_PAGE = "/superadmin/login";

  /* ── Cache d'affichage (non sensible) ──────────────────────────────────
     Comme pour auth.js : l'autorisation réelle est TOUJOURS vérifiée côté
     serveur à chaque requête, ce cache n'a qu'une valeur de confort d'affichage. */
  function setUserCache(superadmin) {
    try {
      sessionStorage.setItem(USER_CACHE_KEY, JSON.stringify(superadmin));
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

  /** Vérifie la session SuperAdmin auprès du serveur et met à jour le cache
   *  d'affichage. Ne redirige pas elle-même : renvoie null si la session
   *  n'est pas valide, à l'appelant de décider (voir requireAuth). */
  async function checkSession() {
    try {
      const res = await apiFetch(`${API_BASE}/me`, { method: "GET" });
      if (!res.ok) {
        clearUserCache();
        return null;
      }
      const superadmin = await res.json();
      setUserCache(superadmin);
      return superadmin;
    } catch (e) {
      return null;
    }
  }

  /** À appeler en haut des pages /superadmin/* protégées : redirige vers
   *  /superadmin/login si la session n'est pas valide côté serveur. */
  async function requireAuth() {
    const superadmin = await checkSession();
    if (!superadmin) {
      window.location.href = LOGIN_PAGE;
      return false;
    }
    return true;
  }

  /** Déconnexion explicite : révoque la session côté serveur puis redirige. */
  async function logout() {
    try {
      await apiFetch(`${API_BASE}/logout`, { method: "POST" });
    } catch (e) {
      /* on nettoie côté client même si l'appel réseau échoue */
    } finally {
      clearUserCache();
      window.location.href = LOGIN_PAGE;
    }
  }

  global.GestionnaireAuthAdmin = {
    API_BASE,
    getUser,
    setUserCache,
    clearUserCache,
    checkSession,
    requireAuth,
    logout,
    authFetch: apiFetch,
  };
})(window);