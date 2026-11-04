import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AuthCard, { PasswordInput } from '../components/AuthCard';

// Deux pages comme dans l'ancienne application : /login (comptes
// d'établissement, templates/login.html) et /superadmin/login (console de la
// plateforme, templates/admin/login.html), chacune avec un lien vers l'autre.
export default function LoginPage({ superadmin = false }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, login } = useAuth();
  const [form, setForm] = useState({ email: '', password: '', etablissementId: '' });
  const [needsEtablissement, setNeedsEtablissement] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (user) {
    return <Navigate to="/" replace />;
  }

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    if (!form.email.trim() || !form.password) {
      setError('Veuillez renseigner votre email et votre mot de passe.');
      return;
    }
    setSubmitting(true);

    try {
      const connectedUser = await login({ ...form, email: form.email.trim(), superadmin });
      if (!connectedUser) {
        throw new Error('Connexion acceptée mais session introuvable : vérifiez que les cookies ne sont pas bloqués.');
      }
      navigate(connectedUser.doit_changer_mdp ? '/change-password' : '/');
    } catch (submitError) {
      // 409 : le même email existe dans plusieurs établissements.
      if (submitError.status === 409) {
        setNeedsEtablissement(true);
      }
      setError(submitError.message || 'Email ou mot de passe incorrect.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      title={superadmin ? 'Connexion SuperAdmin' : 'Connexion'}
      subtitle={superadmin ? "Console d'administration de la plateforme." : 'Entrez votre email et mot de passe pour accéder à votre espace.'}
    >
      {location.state?.message && <div className="alert alert-success" role="alert">{location.state.message}</div>}
      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      <form className="mb-3" onSubmit={handleSubmit} noValidate>
        <div className="mb-3">
          <label htmlFor="email" className="form-label">Email *</label>
          <input type="email" className="form-control" id="email" name="email" placeholder="Entrez votre email" autoComplete="username" value={form.email} onChange={handleChange} autoFocus required />
        </div>

        <div className="mb-3 form-password-toggle">
          <label className="form-label" htmlFor="password">Mot de passe *</label>
          <PasswordInput id="password" name="password" value={form.password} onChange={handleChange} placeholder="Entrez votre mot de passe" autoComplete="current-password" />
        </div>

        {needsEtablissement && !superadmin && (
          <div className="mb-3">
            <label htmlFor="etablissementId" className="form-label">Identifiant de l’établissement</label>
            <input type="number" min="1" className="form-control" id="etablissementId" name="etablissementId" value={form.etablissementId} onChange={handleChange} required />
          </div>
        )}

        <button className="btn btn-primary d-grid w-100" type="submit" disabled={submitting}>
          {submitting ? <span><span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" /> Connexion…</span> : 'Se connecter'}
        </button>
      </form>

      <p className="text-center mb-0">
        {superadmin
          ? <Link to="/login">Connexion à votre établissement</Link>
          : <Link to="/superadmin/login">Connexion administrateur de la plateforme</Link>}
      </p>
    </AuthCard>
  );
}
