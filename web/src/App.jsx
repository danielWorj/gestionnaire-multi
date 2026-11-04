import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout, { roleDe } from './components/Layout';
import LoadingScreen from './components/LoadingScreen';
import { AvecChoixClasse } from './components/Espace';
import { useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import EtablissementsPage from './pages/EtablissementsPage';
import EtablissementDashboardPage from './pages/EtablissementDashboardPage';
import MatieresPage from './pages/MatieresPage';
import EnseignantsPage from './pages/EnseignantsPage';
import ElevesPage from './pages/ElevesPage';
import ParentsPage from './pages/ParentsPage';
import InscriptionsPage from './pages/InscriptionsPage';
import ConfigurationPage from './pages/ConfigurationPage';
import PaiementsPage from './pages/PaiementsPage';
import HorairePage from './pages/HorairePage';
import PedagogiePage from './pages/PedagogiePage';
import CenseurNotesPage from './pages/CenseurNotesPage';
import BulletinsPage from './pages/BulletinsPage';
import EnseignantNotesPage from './pages/EnseignantNotesPage';
import EnseignantHorairePage from './pages/EnseignantHorairePage';
import EnseignantClassesPage from './pages/EnseignantClassesPage';
import EspaceAccueilPage from './pages/EspaceAccueilPage';
import ChoixEspacePage from './pages/ChoixEspacePage';
import AccesRefusePage from './pages/AccesRefusePage';

function AucunRole() {
  const { logout } = useAuth();
  return (
    <div className="container-xxl container-p-y">
      <div className="card"><div className="card-body text-center py-5">
        <i className="bx bx-user-x bx-lg text-muted d-block mb-2" />
        <p className="mb-3">Aucun rôle n'est attribué à votre compte. Contactez l'administration de votre établissement.</p>
        <button type="button" className="btn btn-outline-secondary" onClick={logout}>Se déconnecter</button>
      </div></div>
    </div>
  );
}

function ProtectedRoute({ children, sansEspace = false }) {
  const { user, loading, choisirRole } = useAuth();

  // Compte sans rôle actif (multi-rôles qui n'a pas encore choisi, ou rôle
  // actif retiré). S'il ne lui reste qu'un rôle, on l'ouvre directement.
  const sansRole = user?.type === 'utilisateur' && !user.role && !user.doit_changer_mdp;
  const roleUnique = sansRole && user.roles?.length === 1 ? user.roles[0].libelle : null;
  useEffect(() => {
    if (roleUnique) choisirRole(roleUnique).catch(() => {});
  }, [roleUnique, choisirRole]);

  if (loading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Mot de passe temporaire : le serveur refuse toute autre route (403)
  // tant qu'il n'a pas été changé.
  if (user.doit_changer_mdp) {
    return <Navigate to="/change-password" replace />;
  }

  if (sansRole && !sansEspace) {
    if (roleUnique) return <LoadingScreen />;
    if (!user.roles?.length) return <AucunRole />;
    return <Navigate to="/choisir-espace" replace />;
  }

  return children;
}

const ADMIN = ['Admin', 'SuperAdmin'];
const CENSEUR = ['Censeur', 'Surveillant'];
// Secrétariat : élèves, parents et inscriptions (mêmes droits API que l'Admin
// sur ces trois ressources, cf. server/api/inscription_api.py).
const SCOLARITE = [...ADMIN, 'Secretaire'];

function EmploiDuTempsSelonRole() {
  const { user } = useAuth();
  const role = roleDe(user);
  if (CENSEUR.includes(role)) {
    // Censeur / Surveillant : choix de la classe sur des cartes d'abord.
    const variant = role === 'Censeur' ? 'censeur' : 'surveillant';
    return (
      <AvecChoixClasse key={role} titre="Emploi du temps" icon="bx-calendar" avecAvancement={false}>
        {({ classeId }) => <HorairePage key={classeId} variant={variant} classeImposee={classeId} />}
      </AvecChoixClasse>
    );
  }
  return <HorairePage key={role} variant="admin" />;
}

// Pages portées depuis les anciens templates Flask (server/static/templates),
// avec les rôles autorisés (cf. menu de components/Layout.jsx).
const PAGES = [
  { path: 'etablissements', element: <EtablissementsPage />, roles: ['SuperAdmin'] },
  { path: 'matieres', element: <MatieresPage />, roles: ADMIN },
  { path: 'enseignants', element: <EnseignantsPage />, roles: ADMIN },
  { path: 'eleves', element: <ElevesPage />, roles: SCOLARITE },
  { path: 'parents', element: <ParentsPage />, roles: SCOLARITE },
  { path: 'inscriptions', element: <InscriptionsPage />, roles: SCOLARITE },
  { path: 'configuration', element: <ConfigurationPage />, roles: ADMIN },
  { path: 'paiements', element: <PaiementsPage />, roles: [...ADMIN, 'Comptable'] },
  { path: 'emploi-du-temps', element: <EmploiDuTempsSelonRole />, roles: [...ADMIN, ...CENSEUR] },
  { path: 'pedagogie', element: <PedagogiePage />, roles: CENSEUR },
  { path: 'notes', element: <CenseurNotesPage />, roles: CENSEUR },
  { path: 'bulletins', element: <BulletinsPage />, roles: [...CENSEUR, ...ADMIN] },
  { path: 'enseignant/notes', element: <EnseignantNotesPage />, roles: ['Enseignant'] },
  { path: 'enseignant/classes', element: <EnseignantClassesPage />, roles: ['Enseignant'] },
  { path: 'enseignant/emploi-du-temps', element: <EnseignantHorairePage />, roles: ['Enseignant'] },
];

// Page d'accueil propre à chaque rôle : tableau de bord pour l'administration,
// cartes de rubriques pour les espaces Enseignant / Censeur / Surveillant.
const ACCUEIL = { Comptable: '/paiements', Secretaire: '/inscriptions' };
const ESPACES_RUBRIQUES = ['Enseignant', 'Censeur', 'Surveillant'];

function Accueil() {
  const { user } = useAuth();
  const role = roleDe(user);
  if (role === 'SuperAdmin') return <DashboardPage />;
  if (role === 'Admin') return <EtablissementDashboardPage />;
  if (ESPACES_RUBRIQUES.includes(role)) return <EspaceAccueilPage key={role} role={role} />;
  if (ACCUEIL[role]) return <Navigate to={ACCUEIL[role]} replace />;
  return <div className="card"><div className="card-body text-center text-muted py-5">Aucun espace n'est encore disponible pour votre rôle ({role || 'inconnu'}).</div></div>;
}

function RoleRoute({ roles, children }) {
  const { user } = useAuth();
  if (!roles.includes(roleDe(user))) {
    return <AccesRefusePage />;
  }
  return children;
}

function App() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/superadmin/login" element={user ? <Navigate to="/" replace /> : <LoginPage superadmin />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route path="/choisir-espace" element={<ProtectedRoute sansEspace><ChoixEspacePage /></ProtectedRoute>} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Accueil />} />
        {PAGES.map((page) => (
          <Route key={page.path} path={page.path} element={<RoleRoute roles={page.roles}>{page.element}</RoleRoute>} />
        ))}
      </Route>

      <Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
    </Routes>
  );
}

export default App;
