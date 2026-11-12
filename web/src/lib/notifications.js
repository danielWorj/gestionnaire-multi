import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

// Notifications de l'utilisateur connecté, pour son espace actif (cf.
// server/services/notification_services.py). Relues toutes les 5 minutes
// tant que la page est visible, et à chaque retour sur l'application.
// Hors connexion, api.get sert la dernière copie enregistrée sur l'appareil.

const INTERVALLE_MS = 5 * 60 * 1000;

export const TYPES_NOTIFICATION = {
  echeance_paiement: { icon: 'bx-calendar-exclamation' },
  retard_paiement: { icon: 'bx-error-circle' },
  fin_sequence: { icon: 'bx-time-five' },
  saisie_incomplete: { icon: 'bx-edit' },
  recap_saisie: { icon: 'bx-bar-chart-alt-2' },
};

export const TON_NIVEAU = { info: 'primary', alerte: 'warning', urgent: 'danger' };

export function ilYA(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const heures = Math.round(minutes / 60);
  if (heures < 24) return `il y a ${heures} h`;
  const jours = Math.round(heures / 24);
  if (jours < 7) return `il y a ${jours} jour${jours > 1 ? 's' : ''}`;
  return new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// `actif` : faux pour le SuperAdmin ou un compte sans espace choisi.
export function useNotifications(actif) {
  const [etat, setEtat] = useState({ notifications: [], nonLues: 0, charge: false });
  const actifRef = useRef(actif);
  useEffect(() => { actifRef.current = actif; }, [actif]);

  const charger = useCallback(async () => {
    if (!actifRef.current) return;
    try {
      const data = await api.get('/notifications/');
      if (actifRef.current) setEtat({ notifications: data?.notifications || [], nonLues: data?.non_lues || 0, charge: true });
    } catch {
      // Silencieux : la cloche n'est pas critique, on réessaiera.
    }
  }, []);

  useEffect(() => {
    if (!actif) {
      setEtat({ notifications: [], nonLues: 0, charge: false });
      return undefined;
    }
    charger();
    const t = setInterval(() => { if (document.visibilityState === 'visible') charger(); }, INTERVALLE_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') charger(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [actif, charger]);

  const marquerLue = useCallback(async (notification) => {
    if (notification.lue) return;
    setEtat((e) => ({
      ...e,
      nonLues: Math.max(0, e.nonLues - 1),
      notifications: e.notifications.map((n) => (n.id === notification.id ? { ...n, lue: true } : n)),
    }));
    try {
      await api.post(`/notifications/${notification.id}/lue`);
    } catch {
      charger();
    }
  }, [charger]);

  const toutLire = useCallback(async () => {
    setEtat((e) => ({ ...e, nonLues: 0, notifications: e.notifications.map((n) => ({ ...n, lue: true })) }));
    try {
      await api.post('/notifications/tout-lire');
    } catch {
      charger();
    }
  }, [charger]);

  return { ...etat, recharger: charger, marquerLue, toutLire };
}
