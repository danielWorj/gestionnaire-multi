import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import illustration from '../assets/acces-refuse.webp';

// Affichée quand un compte ouvre (lien, URL tapée, favori…) une page dont
// son rôle actif n'a pas l'accès (cf. RoleRoute dans App.jsx). La sécurité
// réelle reste côté serveur : cette page n'est qu'un retour lisible.
export default function AccesRefusePage() {
  const { user } = useAuth();
  const multiRoles = user?.type === 'utilisateur' && user.roles?.length > 1;

  return (
    <div className="card">
      <div className="card-body text-center py-5 px-3">
        <img
          src={illustration}
          alt=""
          className="img-fluid mb-4"
          style={{ maxWidth: 280 }}
        />
        <span className="badge bg-label-danger mb-3">
          <i className="bx bx-lock-alt me-1" /> Accès refusé
        </span>
        <h4 className="mb-2">Vous n'êtes pas autorisé(e) à accéder à cet espace</h4>
        <p className="text-muted mb-4 mx-auto" style={{ maxWidth: 460 }}>
          Cette page est réservée à un autre profil. Si vous pensez qu'il s'agit d'une erreur,
          contactez l'administrateur de votre établissement.
        </p>
        <div className="d-flex flex-wrap justify-content-center gap-2">
          <Link to="/" replace className="btn btn-primary">
            <i className="bx bx-home-alt me-1" /> Retour à mon espace
          </Link>
          {multiRoles && (
            <Link to="/choisir-espace" className="btn btn-outline-secondary">
              <i className="bx bx-transfer-alt me-1" /> Changer d'espace
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
