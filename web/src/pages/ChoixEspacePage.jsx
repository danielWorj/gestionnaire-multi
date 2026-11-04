import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { lireDernierRole, roleInfo } from '../lib/espaces';
import '../components/espace.css';

// Choix de l'espace de travail pour un compte qui cumule plusieurs rôles
// (ex : Censeur ET Enseignant) : affiché après la connexion, et depuis le
// menu du compte (« Changer d'espace »).
export default function ChoixEspacePage() {
  const navigate = useNavigate();
  const { user, choisirRole, logout } = useAuth();
  const [enCours, setEnCours] = useState(null);
  const [erreur, setErreur] = useState('');

  const roles = (user?.roles || []).map((r) => r.libelle);
  if (!user || user.type !== 'utilisateur' || roles.length < 2) {
    return <Navigate to="/" replace />;
  }

  const dernier = lireDernierRole();
  const actif = user.role?.libelle;
  const prenom = (user.nom || '').split(/\s+/)[0];

  const choisir = async (role) => {
    if (role === actif) {
      navigate('/');
      return;
    }
    setErreur('');
    setEnCours(role);
    try {
      await choisirRole(role);
      navigate('/', { replace: true });
    } catch (e) {
      setErreur(e.message || "Impossible d'ouvrir cet espace.");
      setEnCours(null);
    }
  };

  return (
    <div className="choix-espace">
      <div className="choix-espace-inner">
        <div className="choix-espace-marque">
          <span className="app-brand-logo demo"><i className="bx bxs-graduation" /></span>
          <span className="app-brand-text demo text-body fw-bolder">Gestionnaire</span>
        </div>

        <h3>Bonjour{prenom ? `, ${prenom}` : ''} 👋</h3>
        <p className="choix-espace-sous">
          Vous avez plusieurs rôles{user.etablissement_nom ? ` à ${user.etablissement_nom}` : ''}. Choisissez l'espace dans lequel vous voulez travailler.
        </p>

        {erreur && <div className="alert alert-danger">{erreur}</div>}

        <div className="choix-espace-grille">
          {roles.map((role) => {
            const info = roleInfo(role);
            const badge = role === actif ? 'Espace actuel' : role === dernier && !actif ? 'Dernier utilisé' : null;
            return (
              <button
                key={role}
                type="button"
                className={`choix-role esp-tone-${info.color}`}
                onClick={() => choisir(role)}
                disabled={Boolean(enCours)}
              >
                {badge && <span className="choix-role-badge">{badge}</span>}
                <span className="choix-role-icone"><i className={`bx ${info.icon}`} /></span>
                <span className="choix-role-texte">
                  <span className="choix-role-nom d-block">{info.label}</span>
                  <span className="choix-role-desc d-block">{info.description}</span>
                </span>
                {enCours === role
                  ? <span className="spinner-border spinner-border-sm choix-role-fleche" role="status" aria-label="Ouverture…" />
                  : <i className="bx bx-right-arrow-alt choix-role-fleche" />}
              </button>
            );
          })}
        </div>

        <div className="choix-espace-pied">
          <button type="button" className="btn btn-link text-muted" onClick={logout}>
            <i className="bx bx-power-off me-1" />Se déconnecter
          </button>
        </div>
      </div>
    </div>
  );
}
