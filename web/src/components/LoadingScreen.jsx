import { MessageLent, useConnexionLente } from './Skeleton';

// Écran d'ouverture (vérification de la session). Pas de squelette ici : la
// mise en page dépend du rôle, encore inconnu à ce stade. On affiche donc un
// écran d'accueil aux couleurs de l'application. Sur une connexion lente, un
// message rassure l'utilisateur au bout de quelques secondes.
export default function LoadingScreen({ label = 'Préparation de votre espace…' }) {
  const lente = useConnexionLente();
  return (
    <div className="loading-screen splash" role="status" aria-live="polite">
      <div className="splash-logo" aria-hidden="true">
        <img src="/app-icon.svg" alt="" width="72" height="72" />
      </div>
      <div className="splash-titre">Gestionnaire scolaire</div>
      <div className="splash-label">{label}</div>
      <div className="splash-barre" aria-hidden="true"><span /></div>
      {lente && <div className="mt-3"><MessageLent /></div>}
    </div>
  );
}
