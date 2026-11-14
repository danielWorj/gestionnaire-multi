// Barre de pagination pour une liste paginée côté serveur
// (cf. lib/paginationServeur.js). Même gabarit que <Pager> (components/ui.jsx),
// sans choix du nombre d'éléments par page : il est fixé par la page.
export default function PagerServeur({ pagination, unite = 'épreuves', vide = 'Aucune épreuve', bordure = true }) {
  const { page, pages, start, end, total, loading, setPage } = pagination;
  const debut = Math.max(1, page - 2);
  const fin = Math.min(pages, debut + 4);
  const numeros = [];
  for (let i = debut; i <= fin; i++) numeros.push(i);

  return (
    <div className={`pager d-flex flex-wrap align-items-center justify-content-between gap-2 px-3 py-2${bordure ? ' border-top' : ''}`}>
      <small className="text-muted">{total ? `${start + 1}–${end} sur ${total} ${unite}` : vide}</small>
      {pages > 1 && (
        <div className="pager-actions d-flex align-items-center gap-2">
          <ul className="pagination pagination-sm mb-0">
            <li className={`page-item prev ${page === 1 || loading ? 'disabled' : ''}`}>
              <button type="button" className="page-link" aria-label="Page précédente" onClick={() => setPage(page - 1)}><i className="bx bx-chevron-left" /></button>
            </li>
            {numeros.map((n) => (
              <li key={n} className={`page-item ${n === page ? 'active' : ''}`}>
                <button type="button" className="page-link" aria-current={n === page ? 'page' : undefined} disabled={loading && n !== page} onClick={() => setPage(n)}>{n}</button>
              </li>
            ))}
            <li className={`page-item next ${page === pages || loading ? 'disabled' : ''}`}>
              <button type="button" className="page-link" aria-label="Page suivante" onClick={() => setPage(page + 1)}><i className="bx bx-chevron-right" /></button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
