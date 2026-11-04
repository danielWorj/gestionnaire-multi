import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './Modal';
import { api } from '../lib/api';
import Select from './Select';

// Briques communes aux pages portées depuis les anciens templates Flask
// (server/static/templates/*.html) : en-tête de page, cartes de stats,
// onglets, tableau, toasts, confirmation de suppression.

/* ── Toasts (succès / erreur), partagés par toutes les pages ──────────── */

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  // toast(message, 'error') ou toast(message) — même signature que les anciennes pages.
  const toast = useCallback((message, type = 'success') => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, type, message }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4500);
  }, []);

  const dismiss = (id) => setToasts((list) => list.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-container position-fixed bottom-0 end-0 p-3" style={{ zIndex: 2000 }}>
        {toasts.map((t) => (
          <div key={t.id} className="toast show" role="alert">
            <div className="toast-header">
              <i className={`bx me-2 ${t.type === 'error' ? 'bx-x-circle text-danger' : t.type === 'warning' ? 'bx-error text-warning' : 'bx-check-circle text-success'}`} />
              <strong className="me-auto">{t.type === 'error' ? 'Erreur' : t.type === 'warning' ? 'Attention' : 'Succès'}</strong>
              <button type="button" className="btn-close" aria-label="Fermer" onClick={() => dismiss(t.id)} />
            </div>
            <div className="toast-body">{t.message}</div>
          </div>
        ))}
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

export function StatCard({ label, value, icon, color = 'primary', sub, className = 'col-sm-6 col-xl-3' }) {
  return (
    <div className={`stat-col ${className}`}>
      <div className="card h-100">
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-start">
            <div>
              <span className="fw-semibold d-block mb-1">{label}</span>
              <h3 className="card-title mb-0">{value ?? '—'}</h3>
            </div>
            <div className="avatar flex-shrink-0">
              <span className={`avatar-initial rounded bg-label-${color}`}><i className={`bx ${icon}`} /></span>
            </div>
          </div>
          {sub !== undefined && <small className="text-muted d-block mt-2">{sub || ' '}</small>}
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

// <tbody> avec états chargement / erreur / vide.
export function TBody({ colSpan, loading, error, empty = 'Aucune donnée', emptyIcon, rows, children }) {
  let content = children;
  if (loading) {
    content = <tr><td colSpan={colSpan} className="text-center text-muted py-4"><span className="spinner-border spinner-border-sm me-1" /> Chargement…</td></tr>;
  } else if (error) {
    content = <tr><td colSpan={colSpan} className="text-center text-danger py-4">{error}</td></tr>;
  } else if (rows !== undefined && rows === 0) {
    content = <tr><td colSpan={colSpan} className="text-center text-muted py-4">{emptyIcon && <i className={`bx ${emptyIcon} me-1`} />}{empty}</td></tr>;
  }
  return <tbody className="table-border-bottom-0">{content}</tbody>;
}

export function IconBtn({ icon, title, onClick, danger, disabled }) {
  return (
    <button type="button" className={`btn btn-icon btn-sm ${danger ? 'btn-outline-danger' : 'btn-outline-secondary'} ms-1`} title={title} onClick={onClick} disabled={disabled}>
      <i className={`bx ${icon}`} />
    </button>
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

export function initiales(nom, prenom) {
  const parts = [prenom, nom].filter(Boolean).join(' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

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

export function usePagination(list, initialSize = 50) {
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
