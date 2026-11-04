export default function LoadingScreen({ label = 'Chargement de la session...' }) {
  return (
    <div className="loading-screen">
      <div className="spinner-border text-primary me-3" role="status" />
      <span className="text-muted">{label}</span>
    </div>
  );
}
