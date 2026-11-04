import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const DUREE_FERMETURE = 220;

// Feuille glissante depuis le bas de l'écran (mobile) : fond assombri,
// poignée, fermeture par Échap, par le fond ou par le bouton ✕. Le contenu
// reste monté le temps de l'animation de fermeture.
export default function BottomSheet({ open, onClose, title, children, className = '' }) {
  const [rendu, setRendu] = useState(open);
  const [sortie, setSortie] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (open) {
      setRendu(true);
      setSortie(false);
      return undefined;
    }
    if (!rendu) return undefined;
    setSortie(true);
    const t = setTimeout(() => { setRendu(false); setSortie(false); }, DUREE_FERMETURE);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    document.body.classList.add('sheet-open');
    const surTouche = (e) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', surTouche);
    return () => {
      document.body.classList.remove('sheet-open');
      document.removeEventListener('keydown', surTouche);
    };
  }, [open]);

  if (!rendu) return null;

  return createPortal(
    <div className={`sheet-racine${sortie ? ' sheet-sortie' : ''}`}>
      <div className="sheet-fond" onClick={onClose} />
      <div className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="sheet-poignee" aria-hidden="true" />
        {title && (
          <div className="sheet-tete">
            <div className="sheet-titre">{title}</div>
            <button type="button" className="sheet-fermer" onClick={onClose} aria-label="Fermer"><i className="bx bx-x" /></button>
          </div>
        )}
        <div className="sheet-corps">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
