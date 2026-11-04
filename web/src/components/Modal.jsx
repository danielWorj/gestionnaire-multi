import { useEffect, useRef } from 'react';

// Pile des modales ouvertes : une confirmation peut s'ouvrir par-dessus la
// modale « Gérer la structure ». Échap ne ferme que celle du dessus, et
// body.modal-open n'est retiré qu'à la fermeture de la dernière.
const openStack = [];

// Modale Bootstrap/Sneat pilotée par React (remplace data-bs-toggle="modal").
export default function Modal({
  title,
  subtitle,
  onClose,
  onSubmit,
  footer,
  children,
  size = 'modal-lg',
  headerClassName = '',
  bodyClassName = '',
}) {
  const token = useRef({});
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const self = token.current;
    openStack.push(self);
    document.body.classList.add('modal-open');
    const handleKey = (event) => {
      if (event.key === 'Escape' && openStack[openStack.length - 1] === self) {
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      openStack.splice(openStack.indexOf(self), 1);
      if (openStack.length === 0) {
        document.body.classList.remove('modal-open');
      }
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  const handleSubmit = (event) => {
    event.preventDefault();
    onSubmit?.(event);
  };

  return (
    <>
      <div className="modal fade show d-block" tabIndex="-1" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
        <div className={`modal-dialog modal-dialog-centered ${size}`} role="document">
          <form className="modal-content" onSubmit={handleSubmit} noValidate>
            <div className={`modal-header ${headerClassName}`}>
              <div>
                <h5 className="modal-title">{title}</h5>
                {subtitle && <p className="mb-0 text-muted small">{subtitle}</p>}
              </div>
              <button type="button" className="btn-close" aria-label="Fermer" onClick={onClose} />
            </div>
            <div className={`modal-body ${bodyClassName}`}>{children}</div>
            {footer && <div className="modal-footer">{footer}</div>}
          </form>
        </div>
      </div>
      <div className="modal-backdrop fade show" />
    </>
  );
}
