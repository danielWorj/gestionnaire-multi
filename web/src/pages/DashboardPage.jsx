import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest } from '../lib/api';
import { RESOURCE_ORDER } from '../lib/resources';
import { useAuth } from '../context/AuthContext';
import manWithLaptop from '../assets/sneat/img/illustrations/man-with-laptop-light.png';
import chartSuccess from '../assets/sneat/img/icons/unicons/chart-success.png';
import walletInfo from '../assets/sneat/img/icons/unicons/wallet-info.png';
import ccPrimary from '../assets/sneat/img/icons/unicons/cc-primary.png';
import paypal from '../assets/sneat/img/icons/unicons/paypal.png';

// La première carte dépend du rôle : seul le SuperAdmin peut lister les
// établissements (403 pour les autres).
const SUPERADMIN_FIRST_CARD = { key: 'etablissements', label: 'Établissements', endpoint: '/etablissements/', icon: chartSuccess };
const ETABLISSEMENT_FIRST_CARD = { key: 'inscriptions', label: 'Inscriptions', endpoint: '/inscriptions/', icon: chartSuccess };

const OTHER_STAT_CARDS = [
  { key: 'classes', label: 'Classes', endpoint: '/classes/', icon: walletInfo },
  { key: 'eleves', label: 'Élèves', endpoint: '/eleves/', icon: paypal },
  { key: 'paiements', label: 'Paiements', endpoint: '/paiements/', icon: ccPrimary },
];

const MODULE_ICONS = {
  etablissements: { icon: 'bx-buildings', color: 'primary' },
  matieres: { icon: 'bx-book-open', color: 'info' },
  enseignants: { icon: 'bx-user-voice', color: 'success' },
  classes: { icon: 'bx-chalkboard', color: 'warning' },
  eleves: { icon: 'bx-user', color: 'primary' },
  parents: { icon: 'bx-group', color: 'secondary' },
  inscriptions: { icon: 'bx-id-card', color: 'info' },
  paiements: { icon: 'bx-credit-card', color: 'success' },
};

// Clé de module -> page (les classes se gèrent désormais dans Configuration).
const PAGE_DE = { classes: 'configuration' };
const lienModule = (key) => `/${PAGE_DE[key] || key}`;

function countRows(payload) {
  if (Array.isArray(payload)) {
    return payload.length;
  }
  const rows = payload?.items || payload?.data || payload?.results;
  return Array.isArray(rows) ? rows.length : null;
}

export default function DashboardPage() {
  const { user, isSuperAdmin, activeEtablissementId, etablissements } = useAuth();
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);

  const STAT_CARDS = useMemo(
    () => [isSuperAdmin ? SUPERADMIN_FIRST_CARD : ETABLISSEMENT_FIRST_CARD, ...OTHER_STAT_CARDS],
    [isSuperAdmin],
  );

  useEffect(() => {
    let isMounted = true;

    Promise.all(
      STAT_CARDS.map((card) => apiRequest(card.endpoint).then(countRows).catch(() => null)),
    ).then((values) => {
      if (!isMounted) {
        return;
      }
      setCounts(Object.fromEntries(STAT_CARDS.map((card, index) => [card.key, values[index]])));
      setLoading(false);
    });

    return () => { isMounted = false; };
  }, [STAT_CARDS, activeEtablissementId]);

  const activeEtablissementName = isSuperAdmin
    ? etablissements.find((etab) => etab.id === activeEtablissementId)?.nom
    : user?.etablissement_nom;

  const firstName = (user?.nom || '').split(' ')[0];

  return (
    <div className="row">
      <div className="col-lg-8 mb-3 order-0">
        <div className="card">
          <div className="d-flex align-items-end row">
            <div className="col-sm-7">
              <div className="card-body">
                <h5 className="card-title text-primary">Bonjour {firstName} ! 🎉</h5>
                <p className="mb-3">
                  Bienvenue sur le gestionnaire scolaire
                  {activeEtablissementName ? <> de <span className="fw-bold">{activeEtablissementName}</span></> : ''}.
                  Retrouvez ici l’ensemble de vos modules de gestion.
                </p>
                <Link to="/eleves" className="btn btn-sm btn-outline-primary">Voir les élèves</Link>
              </div>
            </div>
            <div className="col-sm-5 text-center text-sm-left">
              <div className="card-body pb-0 px-0 px-md-4">
                <img src={manWithLaptop} height="110" alt="Illustration tableau de bord" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="col-lg-4 col-md-4 order-1">
        <div className="row">
          {STAT_CARDS.slice(0, 2).map((card) => (
            <StatCard key={card.key} card={card} value={counts[card.key]} loading={loading} />
          ))}
        </div>
      </div>

      <div className="col-12 col-md-8 col-lg-4 order-3 order-md-2">
        <div className="row">
          {STAT_CARDS.slice(2).map((card) => (
            <StatCard key={card.key} card={card} value={counts[card.key]} loading={loading} />
          ))}
        </div>
      </div>

      <div className="col-12 col-lg-8 order-2 order-md-3 order-lg-2 mb-3">
        <div className="card h-100">
          <div className="card-header d-flex align-items-center justify-content-between pb-0">
            <div className="card-title mb-0">
              <h5 className="m-0 me-2">Modules métiers</h5>
              <small className="text-muted">Accès rapide</small>
            </div>
          </div>
          <div className="card-body pt-3">
            <ul className="p-0 m-0 row">
              {RESOURCE_ORDER.map((resource) => {
                const meta = MODULE_ICONS[resource.key] || { icon: 'bx-folder', color: 'primary' };
                return (
                  <li key={resource.key} className="d-flex mb-3 col-md-6">
                    <div className="avatar flex-shrink-0 me-3">
                      <span className={`avatar-initial rounded bg-label-${meta.color}`}>
                        <i className={`bx ${meta.icon}`} />
                      </span>
                    </div>
                    <div className="d-flex w-100 flex-wrap align-items-center justify-content-between gap-2">
                      <div className="me-2">
                        <h6 className="mb-0">{resource.title}</h6>
                        <small className="text-muted">Gérer les {resource.title.toLowerCase()}</small>
                      </div>
                      <Link to={lienModule(resource.key)} className="btn btn-sm btn-icon btn-outline-primary" aria-label={`Ouvrir ${resource.title}`}>
                        <i className="bx bx-chevron-right" />
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ card, value, loading }) {
  return (
    <div className="col-lg-6 col-md-12 col-6 mb-3">
      <div className="card">
        <div className="card-body">
          <div className="card-title d-flex align-items-start justify-content-between">
            <div className="avatar flex-shrink-0">
              <img src={card.icon} alt={card.label} className="rounded" />
            </div>
            <Link to={lienModule(card.key)} className="btn p-0" aria-label={`Voir ${card.label}`}>
              <i className="bx bx-dots-vertical-rounded" />
            </Link>
          </div>
          <span className="fw-semibold d-block mb-1">{card.label}</span>
          <h3 className="card-title text-nowrap mb-1">
            {loading ? <span className="spinner-border spinner-border-sm text-primary" /> : value ?? '—'}
          </h3>
          <small className="text-muted">enregistrement(s)</small>
        </div>
      </div>
    </div>
  );
}
