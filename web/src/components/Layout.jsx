import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { NAV_COURTE, roleInfo, RUBRIQUES } from '../lib/espaces';
import './espace.css';
import Select from './Select';

// Menu par rôle, repris de server/static/js/sidebar.js (sections et libellés).
// Le SuperAdmin garde en plus l'accès aux pages d'établissement, via le
// sélecteur d'établissement de la barre du haut (fonctionnement V2).
const ADMIN = ['Admin', 'SuperAdmin'];
const CENSEUR = ['Censeur', 'Surveillant'];

export const MENU_SECTIONS = [
  {
    header: null,
    items: [
      { to: '/', label: 'Tableau de bord', icon: 'bx-home-circle', roles: [...ADMIN] },
      { to: '/', label: 'Accueil', icon: 'bx-home-circle', roles: [...CENSEUR, 'Enseignant'] },
    ],
  },
  {
    header: 'Super administration',
    items: [{ to: '/etablissements', label: 'Établissements', icon: 'bx-buildings', roles: ['SuperAdmin'] }],
  },
  {
    header: 'Pédagogie',
    items: [
      { to: '/matieres', label: 'Matières', icon: 'bx-book-open', roles: ADMIN },
      { to: '/enseignants', label: 'Enseignants', icon: 'bx-user-voice', roles: ADMIN },
      { to: '/pedagogie', label: 'Pédagogie', icon: 'bx-git-branch', roles: CENSEUR },
      { to: '/enseignant/notes', label: 'Notes', icon: 'bx-edit', roles: ['Enseignant'] },
      { to: '/enseignant/classes', label: 'Mes classes', icon: 'bx-group', roles: ['Enseignant'] },
    ],
  },
  {
    header: 'Inscriptions',
    items: [
      { to: '/eleves', label: 'Élèves', icon: 'bx-user', roles: ADMIN },
      { to: '/parents', label: 'Parents', icon: 'bx-group', roles: ADMIN },
      { to: '/inscriptions', label: 'Inscriptions', icon: 'bx-user-plus', roles: ADMIN },
    ],
  },
  {
    header: 'Horaires',
    items: [
      { to: '/emploi-du-temps', label: 'Emploi du temps', icon: 'bx-calendar', roles: [...ADMIN, ...CENSEUR] },
      { to: '/enseignant/emploi-du-temps', label: 'Horaires', icon: 'bx-calendar', roles: ['Enseignant'] },
    ],
  },
  {
    header: 'Notes',
    items: [
      { to: '/notes', label: 'Notes & discipline', icon: 'bx-spreadsheet', roles: CENSEUR },
      { to: '/bulletins', label: 'Bulletins', icon: 'bx-file', roles: CENSEUR },
    ],
  },
  {
    header: 'Finances',
    items: [{ to: '/paiements', label: 'Paiements', icon: 'bx-wallet', roles: [...ADMIN, 'Comptable'] }],
  },
  {
    header: 'Configuration',
    items: [{ to: '/configuration', label: 'Configuration', icon: 'bx-cog', roles: ADMIN }],
  },
];

export const roleDe = (user) => (user?.type === 'superadmin' ? 'SuperAdmin' : user?.role?.libelle || user?.role || '');

function getInitials(name) {
  return (name || 'U')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export default function Layout() {
  const { user, logout, isSuperAdmin, etablissements, activeEtablissementId, selectEtablissement } = useAuth();
  const location = useLocation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);

  const role = roleDe(user);
  const roleLabel = role === 'SuperAdmin' ? 'SuperAdmin' : role ? roleInfo(role).label : 'Compte';
  const multiRoles = (user?.roles?.length || 0) > 1;
  const rubriques = RUBRIQUES[role];

  // Menu mobile : Sneat l'ouvre via la classe layout-menu-expanded sur <html>.
  const setMenuExpanded = (expanded) => {
    document.documentElement.classList.toggle('layout-menu-expanded', expanded);
  };

  useEffect(() => {
    setMenuExpanded(false);
    setUserMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!userMenuOpen) {
      return undefined;
    }
    const handleClick = (event) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [userMenuOpen]);

  return (
    <div className={`layout-wrapper layout-content-navbar ${rubriques ? 'avec-nav-basse' : ''}`}>
      <div className="layout-container">
        <aside id="layout-menu" className="layout-menu menu-vertical menu bg-menu-theme">
          <div className="app-brand demo">
            <NavLink to="/" className="app-brand-link">
              <span className="app-brand-logo demo">
                <i className="bx bxs-graduation" />
              </span>
              <span className="app-brand-text demo menu-text fw-bolder ms-2">Gestionnaire</span>
            </NavLink>
            <button
              type="button"
              className="btn-reset layout-menu-toggle menu-link text-large ms-auto d-block d-xl-none"
              onClick={() => setMenuExpanded(false)}
              aria-label="Fermer le menu"
            >
              <i className="bx bx-chevron-left bx-sm align-middle" />
            </button>
          </div>

          <div className="menu-inner-shadow" />

          <ul className="menu-inner py-1">
            {MENU_SECTIONS.map((section) => (
              <MenuSection key={section.header || 'root'} section={section} pathname={location.pathname} role={role} />
            ))}
          </ul>
        </aside>

        <div className="layout-page">
          <nav
            className="layout-navbar container-xxl navbar navbar-expand-xl navbar-detached align-items-center bg-navbar-theme"
            id="layout-navbar"
          >
            <div className="layout-menu-toggle navbar-nav align-items-xl-center me-3 me-xl-0 d-xl-none">
              <button type="button" className="btn-reset nav-item nav-link px-0 me-xl-4" onClick={() => setMenuExpanded(true)} aria-label="Ouvrir le menu">
                <i className="bx bx-menu bx-sm" />
              </button>
            </div>

            <div className="navbar-nav-right d-flex align-items-center" id="navbar-collapse">
              <div className="navbar-nav align-items-center">
                <div className="nav-item d-flex align-items-center">
                  <i className="bx bx-buildings fs-4 lh-0 me-2" />
                  {isSuperAdmin ? (
                    <Select
                      className="form-select form-select-sm border-0 shadow-none navbar-etablissement-select"
                      value={activeEtablissementId ?? ''}
                      onChange={(event) => selectEtablissement(event.target.value)}
                      aria-label="Établissement consulté"
                    >
                      {etablissements.length === 0 && <option value="">Aucun établissement</option>}
                      {etablissements.map((etab) => (
                        <option key={etab.id} value={etab.id}>{etab.nom}</option>
                      ))}
                    </Select>
                  ) : (
                    <span className="text-muted text-truncate">{user?.etablissement_nom || 'Plateforme multi-établissement'}</span>
                  )}
                </div>
              </div>

              <ul className="navbar-nav flex-row align-items-center ms-auto">
                {multiRoles && (
                  <li className="nav-item me-2">
                    <NavLink to="/choisir-espace" className={`esp-espace-actif esp-tone-${roleInfo(role).color}`} title="Changer d'espace">
                      <i className={`bx ${roleInfo(role).icon}`} />
                      <span>{roleLabel}</span>
                      <i className="bx bx-transfer-alt esp-espace-actif-swap" />
                    </NavLink>
                  </li>
                )}
                <li className="nav-item navbar-dropdown dropdown-user dropdown" ref={userMenuRef}>
                  <button
                    type="button"
                    className="btn-reset nav-link dropdown-toggle hide-arrow"
                    onClick={() => setUserMenuOpen((open) => !open)}
                    aria-expanded={userMenuOpen}
                  >
                    <div className="avatar avatar-online">
                      <span className="avatar-initial rounded-circle bg-label-primary">{getInitials(user?.nom)}</span>
                    </div>
                  </button>
                  <ul className={`dropdown-menu dropdown-menu-end ${userMenuOpen ? 'show' : ''}`} data-bs-popper="static">
                    <li>
                      <div className="dropdown-item">
                        <div className="d-flex">
                          <div className="flex-shrink-0 me-3">
                            <div className="avatar avatar-online">
                              <span className="avatar-initial rounded-circle bg-label-primary">{getInitials(user?.nom)}</span>
                            </div>
                          </div>
                          <div className="flex-grow-1">
                            <span className="fw-semibold d-block">{user?.nom || 'Utilisateur'}</span>
                            <small className="text-muted">{roleLabel}</small>
                          </div>
                        </div>
                      </div>
                    </li>
                    <li>
                      <div className="dropdown-divider" />
                    </li>
                    {multiRoles && (
                      <li>
                        <NavLink className="dropdown-item" to="/choisir-espace">
                          <i className="bx bx-transfer-alt me-2" />
                          <span className="align-middle">Changer d'espace</span>
                        </NavLink>
                      </li>
                    )}
                    <li>
                      <NavLink className="dropdown-item" to="/change-password">
                        <i className="bx bx-lock-alt me-2" />
                        <span className="align-middle">Changer le mot de passe</span>
                      </NavLink>
                    </li>
                    {ADMIN.includes(roleDe(user)) && (
                      <li>
                        <NavLink className="dropdown-item" to="/configuration">
                          <i className="bx bx-cog me-2" />
                          <span className="align-middle">Configuration</span>
                        </NavLink>
                      </li>
                    )}
                    <li>
                      <div className="dropdown-divider" />
                    </li>
                    <li>
                      <button type="button" className="dropdown-item" onClick={logout}>
                        <i className="bx bx-power-off me-2" />
                        <span className="align-middle">Déconnexion</span>
                      </button>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          </nav>

          <div className="content-wrapper">
            <div className="container-xxl flex-grow-1 container-p-y">
              <Outlet />
            </div>

            <footer className="content-footer footer bg-footer-theme">
              <div className="container-xxl d-flex flex-wrap justify-content-between py-2 flex-md-row flex-column">
                <div className="mb-2 mb-md-0">
                  © {new Date().getFullYear()} Gestionnaire scolaire multi-établissement
                </div>
                <div className="text-muted">Thème Sneat (ThemeSelection, MIT)</div>
              </div>
            </footer>

            <div className="content-backdrop fade" />
          </div>
        </div>
      </div>

      <div className="layout-overlay layout-menu-toggle" onClick={() => setMenuExpanded(false)} />

      {rubriques && <NavBasse rubriques={rubriques} />}
    </div>
  );
}

// Barre de navigation basse (mobile et tablette) des espaces à rubriques :
// accès en un geste du pouce à l'accueil et à chaque rubrique.
function NavBasse({ rubriques }) {
  return (
    <nav className="esp-nav-basse" aria-label="Navigation de l'espace">
      <NavLink to="/" end><i className="bx bx-home-circle" /><span>Accueil</span></NavLink>
      {rubriques.map((r) => (
        <NavLink key={r.to} to={r.to}><i className={`bx ${r.icon}`} /><span>{NAV_COURTE[r.to] || r.label}</span></NavLink>
      ))}
    </nav>
  );
}

function MenuSection({ section, pathname, role }) {
  const items = section.items.filter((item) => item.roles.includes(role));
  if (items.length === 0) {
    return null;
  }

  return (
    <>
      {section.header && (
        <li className="menu-header small text-uppercase">
          <span className="menu-header-text">{section.header}</span>
        </li>
      )}
      {items.map((item) => {
        const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
        return (
          <li key={item.to} className={`menu-item ${active ? 'active' : ''}`}>
            <NavLink to={item.to} end={item.to === '/'} className="menu-link">
              <i className={`menu-icon tf-icons bx ${item.icon}`} />
              <div>{item.label}</div>
            </NavLink>
          </li>
        );
      })}
    </>
  );
}
