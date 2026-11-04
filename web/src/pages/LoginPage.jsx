import { useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AuthCard, { PasswordInput, PinInput } from '../components/AuthCard';

// Deux pages comme dans l'ancienne application : /login (comptes
// d'établissement, connexion par code + PIN) et /superadmin/login (console
// de la plateforme, email + mot de passe), chacune avec un lien vers l'autre.
export default function LoginPage({ superadmin = false }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, login } = useAuth();
  const [form, setForm] = useState({ code: '', pin: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const pinRef = useRef(null);

  if (user) {
    return <Navigate to="/" replace />;
  }

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  // Code : majuscules, lettres et chiffres uniquement ; le curseur passe
  // tout seul au PIN une fois les 4 caractères saisis.
  const handleCode = (event) => {
    const code = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    setForm((current) => ({ ...current, code }));
    if (code.length === 4 && form.code.length < 4) pinRef.current?.focus();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    if (superadmin ? (!form.email.trim() || !form.password) : (form.code.length !== 4 || form.pin.length !== 4)) {
      setError(superadmin
        ? 'Veuillez renseigner votre email et votre mot de passe.'
        : 'Saisissez votre code (4 caractères) et votre PIN (4 chiffres).');
      return;
    }
    setSubmitting(true);

    try {
      const connectedUser = await login(superadmin
        ? { superadmin, email: form.email.trim(), password: form.password }
        : { code: form.code, pin: form.pin });
      if (!connectedUser) {
        throw new Error('Connexion acceptée mais session introuvable : vérifiez que les cookies ne sont pas bloqués.');
      }
      navigate(connectedUser.doit_changer_mdp ? '/change-password' : '/');
    } catch (submitError) {
      setError(submitError.message || (superadmin ? 'Email ou mot de passe incorrect.' : 'Code ou PIN incorrect.'));
      setForm((current) => ({ ...current, pin: '' }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      title={superadmin ? 'Connexion SuperAdmin' : 'Connexion'}
      subtitle={superadmin ? "Console d'administration de la plateforme." : 'Entrez le code et le PIN inscrits sur votre fiche d’accès.'}
    >
      {location.state?.message && <div className="alert alert-success" role="alert">{location.state.message}</div>}
      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      <form className="mb-3" onSubmit={handleSubmit} noValidate>
        {superadmin ? (
          <>
            <div className="mb-3">
              <label htmlFor="email" className="form-label">Email *</label>
              <input type="email" className="form-control" id="email" name="email" placeholder="Entrez votre email" autoComplete="username" value={form.email} onChange={handleChange} autoFocus required />
            </div>

            <div className="mb-3 form-password-toggle">
              <label className="form-label" htmlFor="password">Mot de passe *</label>
              <PasswordInput id="password" name="password" value={form.password} onChange={handleChange} placeholder="Entrez votre mot de passe" autoComplete="current-password" />
            </div>
          </>
        ) : (
          <>
            <div className="mb-3">
              <label htmlFor="code" className="form-label">Code de connexion</label>
              <input
                type="text"
                className="form-control saisie-code"
                id="code"
                name="code"
                placeholder="ABCD"
                autoComplete="username"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                maxLength={4}
                value={form.code}
                onChange={handleCode}
                autoFocus
                required
              />
            </div>

            <div className="mb-3 form-password-toggle">
              <label className="form-label" htmlFor="pin">Code PIN</label>
              <PinInput id="pin" name="pin" value={form.pin} onValue={(pin) => setForm((current) => ({ ...current, pin }))} inputRef={pinRef} />
            </div>
          </>
        )}

        <button className="btn btn-primary d-grid w-100" type="submit" disabled={submitting}>
          {submitting ? <span><span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" /> Connexion…</span> : 'Se connecter'}
        </button>
      </form>

      {!superadmin && (
        <p className="text-center small text-muted">Code ou PIN oublié ? Demandez à l’administrateur de votre établissement de réinitialiser votre PIN.</p>
      )}

      {superadmin && (
        <p className="text-center mb-0">
          <Link to="/login">Connexion à votre établissement</Link>
        </p>
      )}
    </AuthCard>
  );
}
