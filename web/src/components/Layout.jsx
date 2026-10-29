import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RESOURCE_ORDER } from '../lib/resources';

const navIcons = {
  etablissements: '🏫',
  matieres: '📚',
  enseignants: '👩‍🏫',
  classes: '🏫',
  eleves: '🎓',
  parents: '👨‍👩‍👧‍👦',
  inscriptions: '✅',
  paiements: '💳',
};

const navItems = [
  { to: '/', label: 'Dashboard', icon: '🏠' },
  ...RESOURCE_ORDER.map((resource) => ({
    to: `/${resource.key}`,
    label: resource.title,
    icon: navIcons[resource.key] || '📌',
  })),
  { to: '/configuration', label: 'Configuration', icon: '⚙️' },
];

export default function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">G</div>
          <div>
            <strong>Gestionnaire</strong>
            <small>Multi-établissement</small>
          </div>
        </div>

        <nav className="nav">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="user-card">
          <div className="avatar">{user?.nom?.charAt(0)?.toUpperCase() || 'U'}</div>
          <div>
            <strong>{user?.nom || 'Utilisateur'}</strong>
            <small>{user?.role?.libelle || user?.role || 'Compte'}</small>
          </div>
          <button type="button" className="logout-button" onClick={logout}>Déconnexion</button>
        </div>
      </aside>

      <main className="content-area">
        <Outlet />
      </main>
    </div>
  );
}
