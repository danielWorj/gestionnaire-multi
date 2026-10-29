import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../lib/api';

export default function ModulePage({ config, title, endpoint, description, columns = ['id', 'nom', 'statut'] }) {
  const resolvedConfig = config ?? { title, endpoint, description, columns };
  const resolvedTitle = resolvedConfig.title || title || 'Module';
  const resolvedEndpoint = resolvedConfig.endpoint || endpoint;
  const resolvedColumns = resolvedConfig.columns || columns;
  const resolvedDescription = resolvedConfig.description || description;

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const metric = useMemo(() => (items.length > 0 ? `${items.length} éléments` : 'Aucun élément'), [items.length]);

  useEffect(() => {
    if (!resolvedEndpoint) {
      setLoading(false);
      return undefined;
    }

    let isMounted = true;

    async function load() {
      try {
        const payload = await apiRequest(resolvedEndpoint);
        const rows = Array.isArray(payload) ? payload : payload?.items || payload?.data || payload?.results || [];

        if (!isMounted) {
          return;
        }

        setItems(rows);
        setError('');
      } catch (loadError) {
        if (isMounted) {
          setError(loadError.message || 'Impossible de charger les données.');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    load();
    return () => { isMounted = false; };
  }, [resolvedEndpoint]);

  const renderValue = (item, key) => {
    const value = item?.[key];

    if (value === null || value === undefined || value === '') {
      return '—';
    }

    if (key === 'id') {
      return value;
    }

    if (typeof value === 'object') {
      return value.libelle || value.nom || value.email || value.label || '—';
    }

    if (typeof value === 'boolean') {
      return value ? 'Oui' : 'Non';
    }

    return value;
  };

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Module</p>
          <h2>{resolvedTitle}</h2>
        </div>
        <div className="header-badge">{metric}</div>
      </header>

      {resolvedDescription && <p className="module-description">{resolvedDescription}</p>}
      {error && <div className="message error">{error}</div>}

      <div className="table-card">
        {loading ? (
          <p>Chargement...</p>
        ) : items.length === 0 ? (
          <p>Aucune donnée disponible pour ce module.</p>
        ) : (
          <table>
            <thead>
              <tr>
                {resolvedColumns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={item.id ?? `${resolvedTitle}-${index}`}>
                  {resolvedColumns.map((column) => (
                    <td key={`${item.id ?? index}-${column}`}>{renderValue(item, column)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
