import { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';
import { RESOURCE_ORDER } from '../lib/resources';

const fallbackStats = [
  { label: 'Établissements', value: '—' },
  { label: 'Classes', value: '—' },
  { label: 'Élèves', value: '—' },
  { label: 'Paiements', value: '—' },
];

export default function DashboardPage() {
  const [stats, setStats] = useState(fallbackStats);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      try {
        const [etablissements, classes, eleves, paiements] = await Promise.all([
          apiRequest('/etablissements/').catch(() => []),
          apiRequest('/classes/').catch(() => []),
          apiRequest('/eleves/').catch(() => []),
          apiRequest('/paiements/').catch(() => []),
        ]);

        if (!isMounted) {
          return;
        }

        setStats([
          { label: 'Établissements', value: Array.isArray(etablissements) ? String(etablissements.length) : '0' },
          { label: 'Classes', value: Array.isArray(classes) ? String(classes.length) : '0' },
          { label: 'Élèves', value: Array.isArray(eleves) ? String(eleves.length) : '0' },
          { label: 'Paiements', value: Array.isArray(paiements) ? String(paiements.length) : '0' },
        ]);
      } catch {
        if (isMounted) {
          setStats(fallbackStats);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    load();
    return () => { isMounted = false; };
  }, []);

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Vue d’ensemble</p>
          <h2>Tableau de bord</h2>
        </div>
      </header>

      <div className="stats-grid">
        {stats.map((stat) => (
          <div key={stat.label} className="stat-card">
            <span>{stat.label}</span>
            <strong>{loading ? 'Chargement...' : stat.value}</strong>
          </div>
        ))}
      </div>

      <div className="panel-grid">
        <section className="panel">
          <h3>Modules métiers</h3>
          <ul className="bullet-list">
            {RESOURCE_ORDER.map((resource) => (
              <li key={resource.key}>{resource.title}</li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h3>État du système</h3>
          <ul className="bullet-list">
            <li>Serveur : Flask</li>
            <li>Frontend : React + Vite</li>
            <li>Orchestration : Docker Compose</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
