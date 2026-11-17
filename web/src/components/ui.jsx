import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { api } from '../lib/api';
import Select from './Select';
import { Skel, SkelLignesTableau } from './Skeleton';

// Briques communes aux pages portées depuis les anciens templates Flask
// (server/static/templates/*.html) : en-tête de page, cartes de stats,
// onglets, tableau, toasts, confirmation de suppression.

/* ── Toasts (succès / erreur), partagés par toutes les pages ──────────── */

const ToastContext = createContext(() => {});

const TOAST_DUREE = 4500; // ms d'affichage
const TOAST_SORTIE = 280; // ms de l'animation de sortie (cf. .notif-toast-sortie)
const TOAST_TYPES = {
  success: { icon: 'bx-check', titre: 'Succès' },
  error: { icon: 'bx-x', titre: 'Erreur' },
  warning: { icon: 'bx-error', titre: 'Attention' },
  info: { icon: 'bx-info-circle', titre: 'Information' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  // Sortie en deux temps : le toast glisse vers la droite, puis il est retiré.
  const dismiss = useCallback((id) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, sortie: true } : t)));
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_SORTIE);
  }, []);

  // toast(message, 'error') ou toast(message) — même signature que les anciennes pages.
  const toast = useCallback((message, type = 'success') => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, type: TOAST_TYPES[type] ? type : 'success', message }]);
    setTimeout(() => dismiss(id), TOAST_DUREE);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="notif-toasts" aria-live="polite">
        {toasts.map((t) => {
          const info = TOAST_TYPES[t.type];
          return (
            <div key={t.id} className={`notif-toast notif-toast-${t.type}${t.sortie ? ' notif-toast-sortie' : ''}`} role={t.type === 'error' ? 'alert' : 'status'}>
              <span className="notif-toast-icone"><i className={`bx ${info.icon}`} /></span>
              <div className="notif-toast-texte">
                <div className="notif-toast-titre">{info.titre}</div>
                <div className="notif-toast-message">{t.message}</div>
              </div>
              <button type="button" className="notif-toast-fermer" aria-label="Fermer" onClick={() => dismiss(t.id)}><i className="bx bx-x" /></button>
              <span className="notif-toast-duree" style={{ animationDuration: `${TOAST_DUREE}ms` }} />
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/* ── Confirmation (remplace window.confirm et les modales « Confirmer la
   suppression » des anciennes pages) ─────────────────────────────────── */

export function useConfirm() {
  const [request, setRequest] = useState(null);

  const confirm = useCallback((message, options = {}) => new Promise((resolve) => {
    setRequest({ message, ...options, resolve });
  }), []);

  const close = (result) => {
    request?.resolve(result);
    setRequest(null);
  };

  const node = request && (
    <Modal
      size={request.size ?? ''}
      headerClassName="border-danger-subtle"
      title={<span className={request.danger === false ? '' : 'text-danger'}><i className={`bx ${request.icon || 'bx-error'} me-2`} />{request.title || 'Confirmer la suppression'}</span>}
      onClose={() => close(false)}
      footer={(
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={() => close(false)}>Annuler</button>
          <button type="button" className={`btn ${request.danger === false ? 'btn-primary' : 'btn-danger'}`} onClick={() => close(true)}>
            <i className={`bx ${request.confirmIcon || 'bx-trash'} me-1`} /> {request.confirmLabel || 'Oui, supprimer'}
          </button>
        </>
      )}
    >
      <p className="mb-0">{request.message}</p>
      {request.details && (
        <div className="alert alert-warning d-flex gap-2 mt-2 mb-0">
          <i className="bx bx-error-circle" />
          <div>{request.details}</div>
        </div>
      )}
    </Modal>
  );

  return [confirm, node];
}

/* ── Enregistrement d'un formulaire : POST `${path}` en création, PUT
   `${path}${id}` en édition ; messages = [création, modification]. ───── */

export function useSave(onSaved) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const save = async (path, id, payload, messages) => {
    setSaving(true);
    try {
      const result = id ? await api.put(`${path}${id}`, payload) : await api.post(path, payload);
      await onSaved(id ? messages[1] : messages[0], result);
    } catch (err) {
      toast(err.message, 'error');
      setSaving(false);
    }
  };
  return [save, saving];
}

/* ── Mise en page ─────────────────────────────────────────────────────── */

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="page-entete d-flex flex-wrap align-items-center justify-content-between gap-3 mb-4">
      <div className="page-entete-titre">
        <h4 className="fw-bold mb-1">{title}</h4>
        {subtitle && <p className="mb-0 text-muted small">{subtitle}</p>}
      </div>
      {children && <div className="page-entete-actions d-flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

// `loading` : affiche un squelette à la place du chiffre (et du sous-titre).
export function StatCard({ label, value, icon, color = 'primary', sub, loading = false, className = 'col-sm-6 col-xl-3' }) {
  return (
    <div className={`stat-col ${className}`}>
      <div className="card h-100">
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-start">
            <div>
              <span className="fw-semibold d-block mb-1">{label}</span>
              <h3 className="card-title mb-0">{loading ? <Skel w="3.5rem" h="1.6rem" className="my-1" /> : (value ?? '—')}</h3>
            </div>
            <div className="avatar flex-shrink-0">
              <span className={`avatar-initial rounded bg-label-${color}`}><i className={`bx ${icon}`} /></span>
            </div>
          </div>
          {sub !== undefined && (loading
            ? <Skel w="65%" h="0.7rem" className="mt-3" />
            : <small className="text-muted d-block mt-2">{sub || ' '}</small>)}
        </div>
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange, className = 'mb-3' }) {
  return (
    <ul className={`nav nav-tabs ${className}`} role="tablist">
      {tabs.map((t) => (
        <li key={t.key} className="nav-item">
          <button type="button" className={`nav-link ${active === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
            {t.icon && <i className={`bx ${t.icon} me-1`} />}
            {t.label}
            {t.count !== undefined && <span className="badge rounded-pill bg-label-primary ms-2">{t.count}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

// Carte « titre + bouton » contenant un tableau.
export function TableCard({ title, icon, count, actions, children, footer }) {
  return (
    <div className="card">
      <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
        <h5 className="mb-0">
          {icon && <i className={`bx ${icon} me-2 text-primary`} />}
          {title}
          {count !== undefined && <span className="badge rounded-pill bg-label-primary ms-2">{count}</span>}
        </h5>
        {actions && <div className="table-carte-actions d-flex flex-wrap gap-2">{actions}</div>}
      </div>
      <div className="table-responsive text-nowrap">{children}</div>
      {footer && <div className="card-footer">{footer}</div>}
    </div>
  );
}

// <tbody> avec états chargement (lignes squelettes) / erreur / vide.
// `skeletonRows` : nombre de lignes squelettes affichées pendant le chargement.
export function TBody({ colSpan, loading, error, empty = 'Aucune donnée', emptyIcon, rows, skeletonRows = 5, children }) {
  let content = children;
  if (loading) {
    content = <SkelLignesTableau colonnes={colSpan} lignes={skeletonRows} />;
  } else if (error) {
    content = <tr><td colSpan={colSpan} className="text-center text-danger py-4">{error}</td></tr>;
  } else if (rows !== undefined && rows === 0) {
    content = <tr><td colSpan={colSpan} className="text-center text-muted py-4">{emptyIcon && <i className={`bx ${emptyIcon} me-1`} />}{empty}</td></tr>;
  }
  return <tbody className="table-border-bottom-0" aria-busy={loading || undefined}>{content}</tbody>;
}

// Bouton icône discret (sans bordure), même rendu que RowActions.
export function IconBtn({ icon, title, onClick, danger, disabled }) {
  return (
    <button type="button" className={`row-action${danger ? ' row-action-danger' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      <i className={`bx ${icon}`} />
    </button>
  );
}

// Actions d'une ligne de tableau, sans encombrer la colonne : la première
// action visible (`principale`, sinon la première de la liste) reste un
// bouton icône, les autres passent dans un menu « ⋯ ». Une action :
// { icon, label, onClick, danger?, disabled?, hidden?, principale? }.
// Menu en position fixe : il n'est pas coupé par le défilement du tableau.
export function RowActions({ actions }) {
  const visibles = actions.filter((a) => a && !a.hidden);
  const principale = visibles.find((a) => a.principale) || visibles[0];
  const autres = visibles.filter((a) => a !== principale);
  const [position, setPosition] = useState(null);
  const ref = useRef(null);
  const ouvert = position !== null;

  useEffect(() => {
    if (!ouvert) return undefined;
    const fermer = () => setPosition(null);
    const clic = (event) => { if (ref.current && !ref.current.contains(event.target)) fermer(); };
    const touche = (event) => { if (event.key === 'Escape') fermer(); };
    document.addEventListener('mousedown', clic);
    document.addEventListener('keydown', touche);
    window.addEventListener('scroll', fermer, true);
    window.addEventListener('resize', fermer);
    return () => {
      document.removeEventListener('mousedown', clic);
      document.removeEventListener('keydown', touche);
      window.removeEventListener('scroll', fermer, true);
      window.removeEventListener('resize', fermer);
    };
  }, [ouvert]);

  if (!principale) return null;

  const basculer = (event) => {
    if (ouvert) { setPosition(null); return; }
    const r = event.currentTarget.getBoundingClientRect();
    // Ouvre vers le haut si la ligne est en bas de l'écran.
    const versLeHaut = window.innerHeight - r.bottom < 40 * autres.length + 24;
    setPosition(versLeHaut
      ? { bottom: window.innerHeight - r.top + 4, right: window.innerWidth - r.right }
      : { top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  return (
    <div className="row-actions" ref={ref}>
      <button type="button" className={`row-action${principale.danger ? ' row-action-danger' : ''}`} title={principale.label} aria-label={principale.label} onClick={principale.onClick} disabled={principale.disabled}>
        <i className={`bx ${principale.icon}`} />
      </button>
      {autres.length > 0 && (
        <>
          <button type="button" className={`row-action${ouvert ? ' active' : ''}`} title="Plus d'actions" aria-label="Plus d'actions" aria-haspopup="menu" aria-expanded={ouvert} onClick={basculer}>
            <i className="bx bx-dots-horizontal-rounded" />
          </button>
          {ouvert && (
            <div className="dropdown-menu show row-actions-menu" role="menu" style={{ position: 'fixed', left: 'auto', ...position }}>
              {autres.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  role="menuitem"
                  className={`dropdown-item${a.danger ? ' text-danger' : ''}`}
                  disabled={a.disabled}
                  title={a.title}
                  onClick={() => { setPosition(null); a.onClick(); }}
                >
                  <i className={`bx ${a.icon} me-2`} />{a.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Boutons standard d'un pied de modale de formulaire.
export function FormFooter({ onCancel, saving, label = 'Enregistrer', icon = 'bx-check' }) {
  return (
    <>
      <button type="button" className="btn btn-outline-secondary" onClick={onCancel} disabled={saving}>Annuler</button>
      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? <><span className="spinner-border spinner-border-sm me-1" /> Enregistrement…</> : <><i className={`bx ${icon} me-1`} /> {label}</>}
      </button>
    </>
  );
}

// Champ de formulaire libellé + contrôle + message d'invalidité.
export function Field({ label, required, className = 'mb-3', invalid, children, hint }) {
  return (
    <div className={className}>
      {label && <label className="form-label">{label}{required && ' *'}</label>}
      {children}
      {hint && <div className="form-text">{hint}</div>}
      {invalid && <div className="invalid-feedback d-block">{invalid}</div>}
    </div>
  );
}

/* ── Formatage ────────────────────────────────────────────────────────── */

export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('fr-FR');
}

export function formatMontant(value) {
  const n = Number(value || 0);
  return `${n.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} FCFA`;
}

// Libellé d'une classe : « <cycle> <option> » (ex. « 6ème A »).
// `sep` : « » (matiere.html, enseignant.html) ou « · » (eleve.html, parent.html…).
export function classeLabel(classe, cycles = [], sep = ' ') {
  if (!classe) return null;
  const cycle = classe.cycle_libelle || cycles.find((c) => c.id === classe.cycle_id)?.libelle || 'Classe';
  return classe.option ? `${cycle}${sep}${classe.option}` : cycle;
}

// Âge en années révolues à partir d'une date ISO (null si inconnu/aberrant).
export function age(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 100 ? a : null;
}

/* ── Pagination (eleve.html, parent.html, inscription.html, paiements.html) ── */

export function usePagination(list, initialSize = 25) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(initialSize);
  const effective = size || list.length || 1;
  const pages = Math.max(1, Math.ceil(list.length / effective));
  const current = Math.min(page, pages);
  const start = (current - 1) * effective;
  return {
    slice: list.slice(start, start + effective),
    page: current,
    pages,
    start,
    end: Math.min(start + effective, list.length),
    total: list.length,
    size,
    setPage,
    setSize: (v) => { setSize(v); setPage(1); },
    reset: () => setPage(1),
  };
}

export function Pager({ pagination, unit = 'éléments', sizes = [25, 50, 100] }) {
  const { page, pages, start, end, total, size, setPage, setSize } = pagination;
  const from = Math.max(1, page - 2);
  const to = Math.min(pages, from + 4);
  const numbers = [];
  for (let i = from; i <= to; i++) numbers.push(i);
  return (
    <div className="pager d-flex flex-wrap align-items-center justify-content-between gap-2 px-3 py-2 border-top">
      <small className="text-muted">{total ? `${start + 1}–${end} sur ${total} ${unit}` : `Aucun ${unit.replace(/s$/, '')}`}</small>
      <div className="pager-actions d-flex align-items-center gap-2">
        <Select className="form-select form-select-sm" style={{ width: 'auto' }} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Par page">
          {sizes.map((n) => <option key={n} value={n}>{n} / page</option>)}
          <option value={0}>Tout afficher</option>
        </Select>
        {pages > 1 && (
          <ul className="pagination pagination-sm mb-0">
            <li className={`page-item prev ${page === 1 ? 'disabled' : ''}`}><button type="button" className="page-link" onClick={() => setPage(page - 1)}><i className="bx bx-chevron-left" /></button></li>
            {numbers.map((n) => (
              <li key={n} className={`page-item ${n === page ? 'active' : ''}`}><button type="button" className="page-link" onClick={() => setPage(n)}>{n}</button></li>
            ))}
            <li className={`page-item next ${page === pages ? 'disabled' : ''}`}><button type="button" className="page-link" onClick={() => setPage(page + 1)}><i className="bx bx-chevron-right" /></button></li>
          </ul>
        )}
      </div>
    </div>
  );
}

// En-tête de colonne triable.
export function SortTh({ sortKey, sort, setSort, children }) {
  const active = sort.key === sortKey;
  return (
    <th role="button" onClick={() => setSort({ key: sortKey, asc: active ? !sort.asc : true })}>
      {children} <i className={`bx ${active ? (sort.asc ? 'bx-sort-up' : 'bx-sort-down') : 'bx-sort-alt-2'} text-muted`} />
    </th>
  );
}

// Pastilles des filtres actifs (cliquer = effacer ce filtre).
export function FilterChips({ chips, onClear }) {
  if (!chips.length) return null;
  return (
    <div className="d-flex flex-wrap gap-2 mt-3">
      {chips.map(([key, label]) => (
        <button key={key} type="button" className="btn btn-xs btn-sm btn-label-primary rounded-pill py-0" onClick={() => onClear(key)}>
          {label} <i className="bx bx-x" />
        </button>
      ))}
    </div>
  );
}

// Export CSV (séparateur « ; », BOM UTF-8 pour Excel) — repris des anciennes pages.
export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export async function copyText(text, label, toast) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copié dans le presse-papiers.`);
  } catch {
    toast('Impossible de copier automatiquement. Sélectionnez le texte et copiez-le manuellement.', 'error');
  }
}

// Modale « fiche d'accès » : code de connexion + PIN, affichés
// une seule fois. La fiche elle-même (.print-area) est imprimable pour être
// remise en main propre.
export function IdentifiantsModal({ nom, code, pin, onClose, destinataire = "l'utilisateur", titre = 'Compte de connexion créé' }) {
  const toast = useToast();
  return (
    <Modal
      size=""
      title={<><i className="bx bx-key me-2 text-primary" />{titre}</>}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => window.print()}><i className="bx bx-printer me-1" /> Imprimer la fiche</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}><i className="bx bx-check me-1" /> J'ai noté, fermer</button>
        </>
      )}
    >
      <div className="alert alert-warning d-flex align-items-start gap-2 py-2 mb-3 small">
        <i className="bx bx-error mt-1" />
        <div>Ce PIN ne sera plus affiché après la fermeture de cette fenêtre. Notez-le ou imprimez la fiche, et remettez-la à {destinataire}.</div>
      </div>
      <div className="fiche-acces print-area">
        <div className="fiche-acces-titre">Fiche d'accès</div>
        {nom && <div className="fw-semibold mb-2">{nom}</div>}
        <div className="fiche-acces-ligne">
          <span className="fiche-acces-etiquette">Code de connexion</span>
          <span className="fiche-acces-valeur">{code}</span>
        </div>
        {pin && (
          <div className="fiche-acces-ligne">
            <span className="fiche-acces-etiquette">PIN</span>
            <span className="fiche-acces-valeur">{pin}</span>
          </div>
        )}
        <ol className="fiche-acces-consignes">
          <li>Ouvrez l'application et saisissez votre <strong>code</strong> puis votre <strong>PIN</strong>.</li>
          <li>Vous pouvez changer ce PIN quand vous le souhaitez depuis votre espace : menu du profil → <strong>Changer mon code PIN</strong>.</li>
          <li>Ne communiquez jamais votre PIN : votre code seul ne suffit pas pour se connecter.</li>
        </ol>
      </div>
      <button type="button" className="btn btn-outline-primary btn-sm w-100 mt-3" onClick={() => copyText(`Code de connexion : ${code}${pin ? `
PIN : ${pin}` : ''}`, 'Le code et le PIN', toast)}>
        <i className="bx bx-copy me-1" /> Copier le code et le PIN
      </button>
    </Modal>
  );
}
