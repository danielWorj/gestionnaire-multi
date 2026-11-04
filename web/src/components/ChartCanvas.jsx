import { useEffect, useRef, useState } from 'react';
import Chart from 'chart.js/auto';

// Palette des anciennes pages (enseignant.html, dashboard.html…).
export const CHART_COLORS = ['#4361ee', '#f72585', '#4cc9f0', '#7209b7', '#f77f00', '#2a9d8f', '#e63946', '#ffb703', '#8338ec', '#06d6a0'];
export const colorAt = (i) => CHART_COLORS[i % CHART_COLORS.length];

// Légende compacte en bas, utilisée par les camemberts des anciennes pages.
export const PIE_OPTIONS = {
  plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
};

// Graphique Chart.js : recréé quand `config` change. En cas d'échec du rendu,
// affiche un message de repli au lieu de casser la page (comme renderChart()
// dans les anciens templates).
export default function ChartCanvas({ config, height = 220, fallback = 'Graphique indisponible.' }) {
  const canvasRef = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!canvasRef.current || !config) return undefined;
    let chart;
    try {
      chart = new Chart(canvasRef.current, {
        ...config,
        options: { responsive: true, maintainAspectRatio: false, ...config.options },
      });
      setFailed(false);
    } catch (err) {
      console.error('Rendu du graphique impossible :', err);
      setFailed(true);
    }
    return () => chart?.destroy();
  }, [config]);

  return (
    <div style={{ position: 'relative', height }}>
      {failed ? (
        <div className="d-flex flex-column align-items-center justify-content-center h-100 text-muted text-center small">
          <i className="bx bx-bar-chart-alt-2 bx-sm mb-2" />{fallback}
        </div>
      ) : <canvas ref={canvasRef} />}
    </div>
  );
}

// Panneau repliable « titre + méta + contrôles + graphique » (eleve.html,
// parent.html…) : le contenu n'est rendu qu'une fois ouvert.
export function ChartPanel({ title, icon, meta, open, onToggle, controls, children, className = 'mb-2' }) {
  return (
    <div className={`card ${className}`}>
      <button type="button" className="btn text-start d-flex align-items-center gap-2 p-3 w-100" onClick={onToggle} aria-expanded={open}>
        <span className="fw-semibold"><i className={`bx ${icon} me-2 text-primary`} />{title}</span>
        {meta && <small className="text-muted ms-2">{meta}</small>}
        <i className={`bx ${open ? 'bx-chevron-up' : 'bx-chevron-down'} ms-auto`} />
      </button>
      {open && (
        <div className="card-body pt-0">
          {controls && <div className="row g-2 mb-3">{controls}</div>}
          {children}
        </div>
      )}
    </div>
  );
}

export function ChartEmpty({ icon = 'bx-bar-chart-alt-2', children }) {
  return (
    <div className="d-flex flex-column align-items-center justify-content-center text-muted text-center small py-5">
      <i className={`bx ${icon} bx-sm mb-2`} />
      <span>{children}</span>
    </div>
  );
}
