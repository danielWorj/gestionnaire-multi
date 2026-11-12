import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ilYA, TON_NIVEAU, TYPES_NOTIFICATION } from '../lib/notifications';
import BottomSheet from './BottomSheet';
import './notifications.css';

// Cloche de la barre du haut : menu déroulant sur ordinateur, feuille
// glissante sur mobile. L'état (liste, non lues) vient de useNotifications,
// partagé par les deux variantes montées dans le Layout.

const libelleBadge = (n) => (n > 9 ? '9+' : String(n));

function Liste({ notif, onOuvrir }) {
  if (!notif.charge) {
    return <div className="notif-vide"><span className="spinner-border spinner-border-sm" /></div>;
  }
  if (!notif.notifications.length) {
    return (
      <div className="notif-vide">
        <i className="bx bx-bell-off" />
        <p className="mb-0">Aucune notification pour le moment.</p>
      </div>
    );
  }
  return (
    <ul className="notif-liste">
      {notif.notifications.map((n) => {
        const ton = TON_NIVEAU[n.niveau] || 'primary';
        return (
          <li key={n.id}>
            <button type="button" className={`notif-item esp-tone-${ton}${n.lue ? '' : ' non-lue'}`} onClick={() => onOuvrir(n)}>
              <span className="notif-icone"><i className={`bx ${TYPES_NOTIFICATION[n.type]?.icon || 'bx-bell'}`} /></span>
              <span className="notif-texte">
                <span className="notif-titre">{n.titre}</span>
                <span className="notif-message">{n.message}</span>
                <span className="notif-date">{ilYA(n.cree_le)}</span>
              </span>
              {!n.lue && <span className="notif-point" aria-label="Non lue" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EnTete({ notif }) {
  return (
    <div className="notif-tete">
      <span className="notif-tete-titre">Notifications</span>
      {notif.nonLues > 0 && (
        <button type="button" className="btn btn-link btn-sm p-0" onClick={notif.toutLire}>Tout marquer comme lu</button>
      )}
    </div>
  );
}

function useOuvrir(notif, fermer) {
  const navigate = useNavigate();
  return (n) => {
    notif.marquerLue(n);
    fermer();
    if (n.lien) navigate(n.lien);
  };
}

function Bouton({ notif, onClick, className, expanded }) {
  const libelle = notif.nonLues ? `Notifications, ${notif.nonLues} non lue${notif.nonLues > 1 ? 's' : ''}` : 'Notifications';
  return (
    <button type="button" className={`notif-bouton ${className}`} onClick={onClick} aria-label={libelle} aria-expanded={expanded}>
      <i className="bx bx-bell" />
      {notif.nonLues > 0 && <span className="notif-badge">{libelleBadge(notif.nonLues)}</span>}
    </button>
  );
}

// Ordinateur : menu déroulant sous la cloche.
export function NotificationsMenu({ notif }) {
  const [ouvert, setOuvert] = useState(false);
  const ref = useRef(null);
  const ouvrir = useOuvrir(notif, () => setOuvert(false));

  useEffect(() => {
    if (!ouvert) return undefined;
    notif.recharger();
    const fermer = (e) => { if (ref.current && !ref.current.contains(e.target)) setOuvert(false); };
    const echap = (e) => { if (e.key === 'Escape') setOuvert(false); };
    document.addEventListener('mousedown', fermer);
    document.addEventListener('keydown', echap);
    return () => {
      document.removeEventListener('mousedown', fermer);
      document.removeEventListener('keydown', echap);
    };
  }, [ouvert]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="notif-menu" ref={ref}>
      <Bouton notif={notif} className="notif-bouton-barre" onClick={() => setOuvert((o) => !o)} expanded={ouvert} />
      {ouvert && (
        <div className="notif-panneau">
          <EnTete notif={notif} />
          <Liste notif={notif} onOuvrir={ouvrir} />
        </div>
      )}
    </div>
  );
}

// Mobile : feuille glissante depuis le bas.
export function NotificationsMobile({ notif }) {
  const [ouvert, setOuvert] = useState(false);
  const ouvrir = useOuvrir(notif, () => setOuvert(false));
  useEffect(() => { if (ouvert) notif.recharger(); }, [ouvert]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Bouton notif={notif} className="app-topbar-notif" onClick={() => setOuvert(true)} expanded={ouvert} />
      <BottomSheet open={ouvert} onClose={() => setOuvert(false)} title="Notifications" className="notif-sheet">
        {notif.nonLues > 0 && (
          <div className="text-end mb-2">
            <button type="button" className="btn btn-link btn-sm p-0" onClick={notif.toutLire}>Tout marquer comme lu</button>
          </div>
        )}
        <Liste notif={notif} onOuvrir={ouvrir} />
      </BottomSheet>
    </>
  );
}
