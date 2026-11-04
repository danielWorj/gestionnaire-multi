import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiRequest, ROLE_REVOQUE_EVENT, setActiveEtablissementId } from '../lib/api';
import { memoriserDernierRole } from '../lib/espaces';
import { viderCacheEspaces } from '../components/Espace';

const AuthContext = createContext(null);

const ETABLISSEMENT_STORAGE_KEY = 'etablissementActif';

function extractList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload?.items || payload?.data || payload?.results || [];
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // SuperAdmin uniquement : établissements de la plateforme + celui consulté.
  const [etablissements, setEtablissements] = useState([]);
  const [activeEtablissementId, setActiveEtablissementIdState] = useState(null);

  const selectEtablissement = useCallback((id) => {
    const value = id ? Number(id) : null;
    setActiveEtablissementId(value);
    setActiveEtablissementIdState(value);
    if (value) {
      localStorage.setItem(ETABLISSEMENT_STORAGE_KEY, String(value));
    } else {
      localStorage.removeItem(ETABLISSEMENT_STORAGE_KEY);
    }
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const data = await apiRequest('/auth/me');

      if (data?.type === 'superadmin') {
        // Choisir l'établissement de contexte AVANT d'exposer l'utilisateur,
        // pour que les premières requêtes des pages soient déjà scopées.
        const list = extractList(await apiRequest('/etablissements/').catch(() => []));
        const stored = Number(localStorage.getItem(ETABLISSEMENT_STORAGE_KEY));
        const initial = list.find((etab) => etab.id === stored)?.id ?? list[0]?.id ?? null;
        setEtablissements(list);
        selectEtablissement(initial);
      } else {
        setEtablissements([]);
        setActiveEtablissementId(null);
        setActiveEtablissementIdState(null);
      }

      setUser(data);
      return data;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [selectEtablissement]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  // Rôle actif retiré (ou compte désactivé) pendant la session : le serveur
  // répond 403 'role_revoque' ; on relit le compte, ce qui renvoie au choix
  // d'espace (ou à la connexion).
  useEffect(() => {
    const onRevoque = () => {
      viderCacheEspaces();
      refreshUser();
    };
    window.addEventListener(ROLE_REVOQUE_EVENT, onRevoque);
    return () => window.removeEventListener(ROLE_REVOQUE_EVENT, onRevoque);
  }, [refreshUser]);

  // Compte multi-rôles : ouvre (ou change) l'espace de travail. Le serveur
  // réémet les cookies JWT avec ce rôle actif.
  const choisirRole = useCallback(async (role) => {
    await apiRequest('/auth/choisir-role', { method: 'POST', body: JSON.stringify({ role }) });
    viderCacheEspaces();
    memoriserDernierRole(role);
    return refreshUser();
  }, [refreshUser]);

  const login = useCallback(async ({ email, password, etablissementId, superadmin = false }) => {
    const body = { email, password };
    if (!superadmin && etablissementId) {
      body.etablissement_id = Number(etablissementId);
    }

    await apiRequest(superadmin ? '/auth/superadmin/login' : '/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    // /auth/me renvoie un format unique (avec 'type' et 'doit_changer_mdp')
    // pour un Utilisateur comme pour un SuperAdmin.
    return refreshUser();
  }, [refreshUser]);

  const logout = useCallback(async () => {
    try {
      await apiRequest('/auth/logout', { method: 'POST' });
    } catch (error) {
      console.warn('Logout ignored', error);
    } finally {
      setActiveEtablissementId(null);
      viderCacheEspaces();
      setUser(null);
    }
  }, []);

  // Le serveur révoque la session et efface les cookies après un changement
  // de mot de passe : il faut se reconnecter avec le nouveau mot de passe.
  const changePassword = useCallback(async ({ oldPassword, newPassword }) => {
    await apiRequest('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    });
    setUser(null);
  }, []);

  const reloadEtablissements = useCallback(async () => {
    if (user?.type !== 'superadmin') {
      return;
    }
    const list = extractList(await apiRequest('/etablissements/').catch(() => []));
    setEtablissements(list);
    if (!list.some((etab) => etab.id === activeEtablissementId)) {
      selectEtablissement(list[0]?.id ?? null);
    }
  }, [user, activeEtablissementId, selectEtablissement]);

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      refreshUser,
      changePassword,
      choisirRole,
      isSuperAdmin: user?.type === 'superadmin',
      etablissements,
      activeEtablissementId,
      selectEtablissement,
      reloadEtablissements,
    }),
    [user, loading, login, logout, refreshUser, changePassword, choisirRole, etablissements, activeEtablissementId, selectEtablissement, reloadEtablissements],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return context;
}
