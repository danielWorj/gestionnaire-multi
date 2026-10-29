import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../lib/api';

const resourceMeta = {
  '/etablissements/': { title: 'Établissements', key: 'nom' },
  '/matiere/': { title: 'Matières', key: 'libelle' },
  '/classes/': { title: 'Classes', key: 'libelle' },
  '/eleves/': { title: 'Élèves', key: 'nom' },
  '/inscriptions/': { title: 'Inscriptions', key: 'id' },
  '/paiements/': { title: 'Paiements', key: 'id' },
  '/configuration': { title: 'Configuration', key: 'libelle' },
};

export default function ResourcePage({ endpoint, title }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const resolvedTitle = useMemo(() => title || resourceMeta[endpoint]?.title || 'Données', [title, endpoint]);

  const extractRows = (payload) => {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (Array.isArray(payload?.items)) {
      return payload.items;
    }
    if (Array.isArray(payload?.data)) {
      return payload.data;
    }
    if (Array.isArray(payload?.results)) {
      return payload.results;
    }
    return [];
  };

  useEffect(() => {
    let isMounted = true;

    async function load() {
      try {
        const payload = await apiRequest(endpoint);
        const nextItems = extractRows(payload);

        if (!isMounted) {
          return;
        }

        setItems(nextItems);
        setError('');
      } catch (loadError) {
        if (!isMounted) {
          return;
        }
        setError(loadError.message || 'Impossible de charger les données.');
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      isMounted = false;
    };
  }, [endpoint]);

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Gestion</p>
          <h2>{resolvedTitle}</h2>
        </div>
      </header>

      {error && <div className="message error">{error}</div>}

      <div className="table-card">
        {loading ? (
          <p>Chargement...</p>
        ) : items.length === 0 ? (
          <p>Aucune donnée disponible pour le moment.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Libellé</th>
                <th>État</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const primary = item?.name || item?.nom || item?.libelle || item?.label || `Element ${index + 1}`;
                const secondary = item?.etablissement?.nom || item?.role?.libelle || item?.status || 'Actif';
                return (
                  <tr key={item.id || `${primary}-${index}`}>
                    <td>{item.id || index + 1}</td>
                    <td>{primary}</td>
                    <td>{secondary}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
