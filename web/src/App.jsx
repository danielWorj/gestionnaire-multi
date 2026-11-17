import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout, { roleAutorise, roleDe } from './components/Layout';
import LoadingScreen from './components/LoadingScreen';
import { AvecChoixClasse } from './components/Espace';
import { useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import AccesRefusePage from './pages/AccesRefusePage';
// Les pages sont chargées à la demande (une par fichier JS) : le premier
// affichage ne télécharge que la connexion et le cadre de l'application. Le
// service worker garde quand même tous ces fichiers pour le hors connexion.
// Après une mise à jour, un onglet resté ouvert peut réclamer un fichier de
// page qui n'existe plus : on recharge alors l'application une seule fois.
const RECHARGE_KEY = 'pageRechargee';
const page = (charger) => lazy(() => charger().then((module) => {
  try { sessionStorage.removeItem(RECHARGE_KEY); } catch { /* stockage indisponible */ }
  return module;
}).catch((erreur) => {
  let dejaRecharge = true;
  try {
    dejaRecharge = sessionStorage.getItem(RECHARGE_KEY) === '1';
    if (!dejaRecharge) sessionStorage.setItem(RECHARGE_KEY, '1');
  } catch { /* stockage indisponible : pas de rechargement automatique */ }
  if (!dejaRecharge) {
    window.location.reload();
    return new Promise(() => {});
  }
  throw erreur;
}));
const DashboardPage = page(() => import('./pages/DashboardPage'));
const ChangePasswordPage = page(() => import('./pages/ChangePasswordPage'));
const EtablissementsPage = page(() => import('./pages/EtablissementsPage'));
const EtablissementDashboardPage = page(() => import('./pages/EtablissementDashboardPage'));
const MatieresPage = page(() => import('./pages/MatieresPage'));
const EnseignantsPage = page(() => import('./pages/EnseignantsPage'));
const ElevesPage = page(() => import('./pages/ElevesPage'));
const ParentsPage = page(() => import('./pages/ParentsPage'));
const InscriptionsPage = page(() => import('./pages/InscriptionsPage'));
const ListesClassesPage = page(() => import('./pages/ListesClassesPage'));
const ConfigurationPage = page(() => import('./pages/ConfigurationPage'));
const PaiementsPage = page(() => import('./pages/PaiementsPage'));
const TresoreriePage = page(() => import('./pages/TresoreriePage'));
const HorairePage = page(() => import('./pages/HorairePage'));
const PedagogiePage = page(() => import('./pages/PedagogiePage'));
const CenseurNotesPage = page(() => import('./pages/CenseurNotesPage'));
const BulletinsPage = page(() => import('./pages/BulletinsPage'));
const ProcesVerbalPage = page(() => import('./pages/ProcesVerbalPage'));
const ConseilClassePage = page(() => import('./pages/ConseilClassePage'));
const EnseignantNotesPage = page(() => import('./pages/EnseignantNotesPage'));
const EnseignantHorairePage = page(() => import('./pages/EnseignantHorairePage'));
const EnseignantClassesPage = page(() => import('./pages/EnseignantClassesPage'));
const EnseignantEpreuvesPage = page(() => import('./pages/EnseignantEpreuvesPage'));
const EpreuvesPage = page(() => import('./pages/EpreuvesPage'));
const EspaceAccueilPage = page(() => import('./pages/EspaceAccueilPage'));
const ChoixEspacePage = page(() => import('./pages/ChoixEspacePage'));
const JournalPage = page(() => import('./pages/JournalPage'));
const UtilisateursPage = page(() => import('./pages/UtilisateursPage'));
const SuperAdminsPage = page(() => import('./pages/SuperAdminsPage'));
const ParentAccueilPage = page(() => import('./pages/ParentAccueilPage'));
const ParentPaiementsPage = page(() => import('./pages/ParentPaiementsPage'));
const ParentBulletinsPage = page(() => import('./pages/ParentBulletinsPage'));

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

  // Changement de PIN imposé (inactif aujourd'hui : les PIN générés sont
  // définitifs) : le serveur refuse toute autre route (403) tant qu'il n'a
  // pas été changé.
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
// Pseudo-rôle : enseignant titulaire d'une classe (cf. roleAutorise).
const TITULAIRE = 'Titulaire';
// Secrétariat : élèves, parents et inscriptions (mêmes droits API que l'Admin
// sur ces trois ressources, cf. server/api/inscription_api.py).
const SCOLARITE = [...ADMIN, 'Secretaire'];
// Listes de classe : tous les profils (chacun sur ses classes, cf.
// server/services/liste_classe_services.py).
const TOUS_LES_PROFILS = [...ADMIN, ...CENSEUR, 'Enseignant', 'Secretaire', 'Comptable'];

function EmploiDuTempsSelonRole() {
  const { user } = useAuth();
  const role = roleDe(user);
  if (role === 'Enseignant') {
    // Titulaire : emploi du temps complet de sa classe (consultation).
    return (
      <AvecChoixClasse titre="Emploi du temps de ma classe" icon="bx-calendar-check" avecAvancement={false}>
        {({ classeId, classe }) => <EnseignantHorairePage key={classeId} classeImposee={classeId} classeLabel={classe?.label || ''} />}
      </AvecChoixClasse>
    );
  }
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
  // Tableau de bord de l'établissement choisi dans la barre du haut (le même
  // que celui de l'Admin) ; l'accueil du SuperAdmin est la vue réseau.
  { path: 'etablissement', element: <EtablissementDashboardPage />, roles: ['SuperAdmin'] },
  { path: 'utilisateurs', element: <UtilisateursPage />, roles: ['SuperAdmin'] },
  { path: 'super-admins', element: <SuperAdminsPage />, roles: ['SuperAdmin'] },
  { path: 'matieres', element: <MatieresPage />, roles: ADMIN },
  { path: 'enseignants', element: <EnseignantsPage />, roles: ADMIN },
  // Le Censeur y change la classe d'un élève (parmi ses classes) ; le reste de
  // la page lui est en lecture seule.
  { path: 'eleves', element: <ElevesPage />, roles: [...SCOLARITE, 'Censeur'] },
  { path: 'parents', element: <ParentsPage />, roles: SCOLARITE },
  { path: 'inscriptions', element: <InscriptionsPage />, roles: SCOLARITE },
  { path: 'listes-classes', element: <ListesClassesPage />, roles: TOUS_LES_PROFILS },
  { path: 'configuration', element: <ConfigurationPage />, roles: ADMIN },
  { path: 'paiements', element: <PaiementsPage />, roles: [...ADMIN, 'Comptable'] },
  { path: 'tresorerie', element: <TresoreriePage />, roles: [...ADMIN, 'Comptable'] },
  // Enseignant : uniquement s'il est titulaire (professeur principal), pour
  // ses classes — cf. TITULAIRE ci-dessous et le serveur.
  { path: 'emploi-du-temps', element: <EmploiDuTempsSelonRole />, roles: [...ADMIN, ...CENSEUR, TITULAIRE] },
  { path: 'pedagogie', element: <PedagogiePage />, roles: CENSEUR },
  // Admin / SuperAdmin : lecture ET saisie des notes, et discipline.
  { path: 'notes', element: <CenseurNotesPage />, roles: [...CENSEUR, ...ADMIN, TITULAIRE] },
  { path: 'bulletins', element: <BulletinsPage />, roles: [...CENSEUR, ...ADMIN, TITULAIRE] },
  // Procès-verbal d'évaluation (aperçu, impression, PDF), comme /api/pv :
  // Admin/SuperAdmin, Censeur/Surveillant (leurs classes), titulaire.
  { path: 'proces-verbal', element: <ProcesVerbalPage />, roles: [...ADMIN, ...CENSEUR, TITULAIRE] },
  // Conseil de classe : Censeur (ses classes), Admin / SuperAdmin (classe,
  // niveau, cycle ou établissement), comme /api/conseil.
  { path: 'conseil-de-classe', element: <ConseilClassePage />, roles: [...ADMIN, 'Censeur'] },
  { path: 'enseignant/notes', element: <EnseignantNotesPage />, roles: ['Enseignant'] },
  { path: 'enseignant/classes', element: <EnseignantClassesPage />, roles: ['Enseignant'] },
  { path: 'enseignant/emploi-du-temps', element: <EnseignantHorairePage />, roles: ['Enseignant'] },
  // Épreuves : l'enseignant dépose et gère les siennes ; l'administration voit,
  // filtre, ajoute et télécharge celles de tout l'établissement.
  { path: 'enseignant/epreuves', element: <EnseignantEpreuvesPage />, roles: ['Enseignant'] },
  { path: 'epreuves', element: <EpreuvesPage />, roles: ADMIN },
  { path: 'journal', element: <JournalPage />, roles: [...ADMIN, 'Censeur', 'Comptable'] },
  // Espace parent : uniquement les enfants de la famille connectée.
  { path: 'parent/paiements', element: <ParentPaiementsPage />, roles: ['Parent'] },
  { path: 'parent/bulletins', element: <ParentBulletinsPage />, roles: ['Parent'] },
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
  if (role === 'Parent') return <ParentAccueilPage />;
  if (ACCUEIL[role]) return <Navigate to={ACCUEIL[role]} replace />;
  return <div className="card"><div className="card-body text-center text-muted py-5">Aucun espace n'est encore disponible pour votre rôle ({role || 'inconnu'}).</div></div>;
}

function RoleRoute({ roles, children }) {
  const { user } = useAuth();
  if (!roleAutorise(roles, user)) {
    return <AccesRefusePage />;
  }
  return children;
}

function App() {
  const { user } = useAuth();

  return (
    <Suspense fallback={<LoadingScreen />}>
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
    </Suspense>
  );
}

export default App;
