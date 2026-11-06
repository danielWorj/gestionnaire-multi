import { MessageLent, useConnexionLente } from './Skeleton';

// Écran d'ouverture (vérification de la session). Reste un spinner : la mise
// en page dépend du rôle, encore inconnu à ce stade. Sur une connexion lente,
// un message rassure l'utilisateur au bout de quelques secondes.
export default function LoadingScreen({ label = 'Chargement de la session...' }) {
  const lente = useConnexionLente();
  return (
    <div className="loading-screen flex-column">
      <div className="d-flex align-items-center" role="status">
        <div className="spinner-border text-primary me-3" aria-hidden="true" />
        <span className="text-muted">{label}</span>
      </div>
      {lente && <MessageLent />}
    </div>
  );
}
