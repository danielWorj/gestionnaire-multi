import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { NAV_COURTE, NAV_MOBILE, roleInfo } from '../lib/espaces';
import { useTableauxMobiles } from '../lib/tableauxMobiles';
import BottomSheet from './BottomSheet';
import HorsLigne from './HorsLigne';
import './espace.css';
import './app-mobile.css';
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
      { to: '/', label: 'Tableau de bord', icon: 'bx-home-circle', roles: ['Admin'] },
      { to: '/', label: 'Vue réseau', icon: 'bx-network-chart', roles: ['SuperAdmin'] },
      { to: '/', label: 'Accueil', icon: 'bx-home-circle', roles: [...CENSEUR, 'Enseignant'] },
    ],
  },
  {
    header: 'Super administration',
    items: [
      { to: '/etablissements', label: 'Établissements', icon: 'bx-buildings', roles: ['SuperAdmin'] },
      { to: '/etablissement', label: "Tableau de bord de l'école", icon: 'bx-line-chart', roles: ['SuperAdmin'] },
      { to: '/utilisateurs', label: 'Comptes utilisateurs', icon: 'bx-id-card', roles: ['SuperAdmin'] },
      { to: '/super-admins', label: 'Comptes SuperAdmin', icon: 'bx-shield-quarter', roles: ['SuperAdmin'] },
    ],
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
      { to: '/eleves', label: 'Élèves', icon: 'bx-user', roles: [...ADMIN, 'Secretaire'] },
      { to: '/parents', label: 'Parents', icon: 'bx-group', roles: [...ADMIN, 'Secretaire'] },
      { to: '/inscriptions', label: 'Inscriptions', icon: 'bx-user-plus', roles: [...ADMIN, 'Secretaire'] },
      { to: '/listes-classes', label: 'Listes de classe', icon: 'bx-list-ul', roles: [...ADMIN, ...CENSEUR, 'Enseignant', 'Secretaire', 'Comptable'] },
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
      { to: '/notes', label: 'Notes & discipline', icon: 'bx-spreadsheet', roles: [...CENSEUR, 'SuperAdmin'] },
      { to: '/bulletins', label: 'Bulletins', icon: 'bx-file', roles: [...CENSEUR, ...ADMIN] },
    ],
  },
  {
    header: 'Finances',
    items: [{ to: '/paiements', label: 'Paiements', icon: 'bx-wallet', roles: [...ADMIN, 'Comptable'] }],
  },
  {
    header: 'Configuration',
    items: [
      { to: '/configuration', label: 'Configuration', icon: 'bx-cog', roles: ADMIN },
      { to: '/journal', label: 'Journal des modifications', icon: 'bx-history', roles: [...ADMIN, 'Censeur'] },
    ],
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

const estActif = (to, pathname) => (to === '/' ? pathname === '/' : pathname.startsWith(to));

// Mobile et tablette (< 1200px) : barre du haut compacte, barre de
// navigation basse et menu complet dans une feuille glissante. Ordinateur :
// menu latéral Sneat et barre du haut détachée.
export default function Layout() {
  const { user, logout, isSuperAdmin, etablissements, activeEtablissementId, selectEtablissement } = useAuth();
  const location = useLocation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [menuMobileOuvert, setMenuMobileOuvert] = useState(false);
  const userMenuRef = useRef(null);
  const contenuRef = useRef(null);

  const role = roleDe(user);
  const roleLabel = role === 'SuperAdmin' ? 'SuperAdmin' : role ? roleInfo(role).label : 'Compte';
  const multiRoles = (user?.roles?.length || 0) > 1;
  // Le SuperAdmin a un mot de passe, les comptes d'établissement un code PIN.
  const libelleSecret = isSuperAdmin ? 'Changer le mot de passe' : 'Changer mon code PIN';
  const etablissementNom = isSuperAdmin
    ? etablissements.find((etab) => etab.id === activeEtablissementId)?.nom || 'Aucun établissement'
    : user?.etablissement_nom || 'Plateforme multi-établissement';

  useTableauxMobiles(contenuRef);

  useEffect(() => {
    setUserMenuOpen(false);
    setMenuMobileOuvert(false);
    window.scrollTo(0, 0);
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
    <div className="layout-wrapper layout-content-navbar app-shell">
      <div className="layout-container">
        <aside id="layout-menu" className="layout-menu menu-vertical menu bg-menu-theme">
          <div className="app-brand demo">
            <NavLink to="/" className="app-brand-link">
              <span className="app-brand-logo demo">
                <i className="bx bxs-graduation" />
              </span>
              <span className="app-brand-text demo menu-text fw-bolder ms-2">Gestionnaire</span>
            </NavLink>
          </div>

          <div className="menu-inner-shadow" />

          <ul className="menu-inner py-1">
            {MENU_SECTIONS.map((section) => (
              <MenuSection key={section.header || 'root'} section={section} pathname={location.pathname} role={role} />
            ))}
          </ul>
        </aside>

        <div className="layout-page">
          {/* Barre du haut — mobile et tablette */}
          <header className="app-topbar">
            <NavLink to="/" className="app-topbar-logo" aria-label="Accueil">
              <i className="bx bxs-graduation" />
            </NavLink>
            <button type="button" className="app-topbar-contexte" onClick={() => setMenuMobileOuvert(true)}>
              <span className="app-topbar-etab">
                <span className="text-truncate">{etablissementNom}</span>
                {isSuperAdmin && <i className="bx bx-chevron-down" />}
              </span>
              <span className="app-topbar-role">{roleLabel}</span>
            </button>
            {multiRoles && (
              <NavLink to="/choisir-espace" className={`app-topbar-espace esp-tone-${roleInfo(role).color}`} aria-label="Changer d'espace">
                <i className="bx bx-transfer-alt" />
              </NavLink>
            )}
            <button type="button" className="app-topbar-avatar" onClick={() => setMenuMobileOuvert(true)} aria-label="Mon compte">
              <span className="avatar-initial rounded-circle bg-label-primary">{getInitials(user?.nom)}</span>
            </button>
          </header>

          {/* Barre du haut — ordinateur */}
          <nav
            className="layout-navbar container-xxl navbar navbar-expand-xl navbar-detached align-items-center bg-navbar-theme"
            id="layout-navbar"
          >
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
                    <span className="text-muted text-truncate">{etablissementNom}</span>
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
                            {user?.code_connexion && <small className="text-muted d-block">Code : <span className="font-monospace fw-semibold">{user.code_connexion}</span></small>}
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
                        <span className="align-middle">{libelleSecret}</span>
                      </NavLink>
                    </li>
                    {ADMIN.includes(role) && (
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
            <div className="container-xxl flex-grow-1 container-p-y app-content" ref={contenuRef}>
              <HorsLigne role={role} />
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
          </div>
        </div>
      </div>

      <NavMobile role={role} pathname={location.pathname} menuOuvert={menuMobileOuvert} onMenu={() => setMenuMobileOuvert(true)} />

      <BottomSheet open={menuMobileOuvert} onClose={() => setMenuMobileOuvert(false)} className="menu-mobile">
        <div className="mm-profil">
          <span className="avatar-initial rounded-circle bg-label-primary mm-avatar">{getInitials(user?.nom)}</span>
          <div className="min-w-0 flex-grow-1">
            <div className="mm-nom">{user?.nom || 'Utilisateur'}</div>
            <div className="mm-role">{roleLabel}{user?.code_connexion && <> · Code <span className="font-monospace">{user.code_connexion}</span></>}</div>
          </div>
          <button type="button" className="sheet-fermer" onClick={() => setMenuMobileOuvert(false)} aria-label="Fermer"><i className="bx bx-x" /></button>
        </div>

        {isSuperAdmin ? (
          <div className="mm-bloc">
            <label className="mm-etiquette" htmlFor="mm-etablissement">Établissement consulté</label>
            <Select
              id="mm-etablissement"
              className="form-select"
              value={activeEtablissementId ?? ''}
              onChange={(event) => selectEtablissement(event.target.value)}
              aria-label="Établissement consulté"
            >
              {etablissements.length === 0 && <option value="">Aucun établissement</option>}
              {etablissements.map((etab) => (
                <option key={etab.id} value={etab.id}>{etab.nom}</option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="mm-bloc mm-etab"><i className="bx bx-buildings" /><span>{etablissementNom}</span></div>
        )}

        <div className="mm-section">
          <div className="mm-etiquette">Rubriques</div>
          <div className="mm-grille">
            {itemsDuRole(role).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={`mm-tuile${estActif(item.to, location.pathname) ? ' actif' : ''}`}
                onClick={() => setMenuMobileOuvert(false)}
              >
                <span className="mm-tuile-icone"><i className={`bx ${item.icon}`} /></span>
                <span className="mm-tuile-label">{item.label}</span>
              </NavLink>
            ))}
          </div>
        </div>

        <div className="mm-section">
          <div className="mm-etiquette">Mon compte</div>
          <div className="mm-liste">
            {multiRoles && (
              <NavLink to="/choisir-espace" className="mm-ligne">
                <i className="bx bx-transfer-alt" /><span>Changer d'espace</span><i className="bx bx-chevron-right mm-chevron" />
              </NavLink>
            )}
            <NavLink to="/change-password" className="mm-ligne">
              <i className="bx bx-lock-alt" /><span>{libelleSecret}</span><i className="bx bx-chevron-right mm-chevron" />
            </NavLink>
            <button type="button" className="mm-ligne mm-ligne-danger" onClick={logout}>
              <i className="bx bx-power-off" /><span>Déconnexion</span>
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}

// Onglets de la barre basse : ceux de NAV_MOBILE pour le rôle (à défaut, les
// premières entrées de son menu), puis « Menu » qui ouvre tout le reste.
const itemsDuRole = (role) => MENU_SECTIONS.flatMap((section) => section.items.filter((item) => item.roles.includes(role)));

function ongletsMobiles(role) {
  const items = itemsDuRole(role);
  const parChemin = new Map(items.map((item) => [item.to, item]));
  const voulus = NAV_MOBILE[role] || items.slice(0, 4).map((item) => item.to);
  const onglets = voulus.map((to) => parChemin.get(to)).filter(Boolean);
  if (onglets.length === 0) onglets.push({ to: '/', label: 'Accueil', icon: 'bx-home-circle' });
  return onglets;
}

function NavMobile({ role, pathname, menuOuvert, onMenu }) {
  const onglets = ongletsMobiles(role);
  return (
    <nav className="app-nav-basse" aria-label="Navigation principale">
      {onglets.map((item) => {
        const actif = !menuOuvert && estActif(item.to, pathname);
        return (
          <NavLink key={item.to} to={item.to} end={item.to === '/'} className={actif ? 'actif' : ''} aria-current={actif ? 'page' : undefined}>
            <span className="app-nav-icone"><i className={`bx ${item.icon}`} /></span>
            <span className="app-nav-label">{NAV_COURTE[item.to] || item.label}</span>
          </NavLink>
        );
      })}
      <button type="button" className={menuOuvert ? 'actif' : ''} onClick={onMenu} aria-haspopup="dialog">
        <span className="app-nav-icone"><i className="bx bx-grid-alt" /></span>
        <span className="app-nav-label">Menu</span>
      </button>
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
      {items.map((item) => (
        <li key={item.to} className={`menu-item ${estActif(item.to, pathname) ? 'active' : ''}`}>
          <NavLink to={item.to} end={item.to === '/'} className="menu-link">
            <i className={`menu-icon tf-icons bx ${item.icon}`} />
            <div>{item.label}</div>
          </NavLink>
        </li>
      ))}
    </>
  );
}
