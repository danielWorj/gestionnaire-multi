import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AuthCard, { PasswordInput } from '../components/AuthCard';
import LoadingScreen from '../components/LoadingScreen';

// Règles alignées sur valider_force_mot_de_passe() côté backend
// (models/authentification_models.py) : 8 caractères, une lettre, un chiffre.
// Simple confort UX : la validation qui fait foi reste côté serveur.
function evaluatePassword(password) {
  return {
    length: password.length >= 8,
    letter: /[A-Za-z]/.test(password),
    digit: /[0-9]/.test(password),
  };
}

function initials(nom) {
  if (!nom) return '--';
  const parts = nom.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '--';
}

function Rule({ ok, children }) {
  return (
    <li className={ok ? 'text-success' : 'text-muted'}>
      <i className={`bx ${ok ? 'bx-check-circle' : 'bx-circle'} me-1`} />
      {children}
    </li>
  );
}

export default function ChangePasswordPage() {
  const navigate = useNavigate();
  const { user, loading, changePassword, logout } = useAuth();
  const [form, setForm] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [doneMessage, setDoneMessage] = useState('');

  if (loading) {
    return <LoadingScreen />;
  }

  if (!user) {
    // Après succès, changePassword() a vidé la session : retour au login.
    return <Navigate to="/login" replace state={doneMessage ? { message: doneMessage } : undefined} />;
  }

  const rules = evaluatePassword(form.newPassword);
  const score = [rules.length, rules.letter, rules.digit].filter(Boolean).length;
  const strengthPct = form.newPassword.length === 0 ? 0 : (score / 3) * 100;
  const strengthColor = score <= 1 ? 'bg-danger' : score === 2 ? 'bg-warning' : 'bg-success';
  const matches = form.confirmPassword === form.newPassword;

  const handleChange = (event) => {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.oldPassword || !form.newPassword || !form.confirmPassword) {
      setError('Veuillez renseigner les trois champs.');
      return;
    }
    if (!(rules.length && rules.letter && rules.digit)) {
      setError('Le nouveau mot de passe doit contenir au moins 8 caractères, une lettre et un chiffre.');
      return;
    }
    if (!matches) {
      setError('La confirmation ne correspond pas au nouveau mot de passe.');
      return;
    }
    if (form.oldPassword === form.newPassword) {
      setError("Le nouveau mot de passe doit être différent de l'ancien.");
      return;
    }

    setSubmitting(true);
    try {
      setDoneMessage('Mot de passe modifié. Reconnectez-vous avec votre nouveau mot de passe.');
      await changePassword(form);
    } catch (submitError) {
      setDoneMessage('');
      setError(submitError.message || 'Impossible de modifier le mot de passe.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (user.doit_changer_mdp) {
      // Changement obligatoire : seule la déconnexion est proposée.
      await logout();
      return;
    }
    navigate('/');
  };

  return (
    <AuthCard
      title="Changer le mot de passe 🔒"
      subtitle={user.doit_changer_mdp
        ? 'Votre mot de passe temporaire doit être remplacé avant de continuer.'
        : 'Choisissez un nouveau mot de passe pour sécuriser votre compte.'}
    >
      {user.doit_changer_mdp && (
        <div className="alert alert-warning d-flex align-items-center gap-2 py-2" role="alert">
          <i className="bx bx-error" />
          <span>Mot de passe temporaire — le changement est obligatoire avant de continuer.</span>
        </div>
      )}

      <div className="d-flex align-items-center gap-2 mb-3 p-2 border rounded">
        <div className="avatar">
          <span className="avatar-initial rounded-circle bg-label-primary">{initials(user.nom)}</span>
        </div>
        <div>
          <div className="fw-semibold">{user.nom || '—'}</div>
          <small className="text-muted">{user.email || '—'}</small>
        </div>
      </div>

      <form className="mb-3" onSubmit={handleSubmit} noValidate>
        <div className="mb-3 form-password-toggle">
          <label className="form-label" htmlFor="oldPassword">Mot de passe actuel *</label>
          <PasswordInput id="oldPassword" name="oldPassword" value={form.oldPassword} onChange={handleChange} placeholder="Entrez votre mot de passe actuel" autoComplete="current-password" autoFocus />
        </div>

        <div className="mb-2 form-password-toggle">
          <label className="form-label" htmlFor="newPassword">Nouveau mot de passe *</label>
          <PasswordInput id="newPassword" name="newPassword" value={form.newPassword} onChange={handleChange} placeholder="Entrez votre nouveau mot de passe" autoComplete="new-password" />
          <div className="progress mt-2" style={{ height: 4 }}>
            <div className={`progress-bar ${strengthColor}`} role="progressbar" style={{ width: `${strengthPct}%` }} />
          </div>
        </div>

        <ul className="list-unstyled small mb-3">
          <Rule ok={rules.length}>Au moins 8 caractères</Rule>
          <Rule ok={rules.letter}>Au moins une lettre</Rule>
          <Rule ok={rules.digit}>Au moins un chiffre</Rule>
        </ul>

        <div className="mb-3 form-password-toggle">
          <label className="form-label" htmlFor="confirmPassword">Confirmer le nouveau mot de passe *</label>
          <PasswordInput id="confirmPassword" name="confirmPassword" value={form.confirmPassword} onChange={handleChange} placeholder="Confirmez votre nouveau mot de passe" autoComplete="new-password" />
          {form.confirmPassword && (
            <small className={`d-block mt-1 ${matches ? 'text-success' : 'text-danger'}`}>
              <i className={`bx ${matches ? 'bx-check-circle' : 'bx-x-circle'} me-1`} />
              {matches ? 'Les mots de passe correspondent' : 'Les mots de passe ne correspondent pas'}
            </small>
          )}
        </div>

        <div className="alert alert-info d-flex gap-2 small py-2" role="note">
          <i className="bx bx-info-circle" />
          <span>Pour votre sécurité, vous serez déconnecté(e) après ce changement et devrez vous reconnecter avec votre nouveau mot de passe.</span>
        </div>

        {error && <div className="alert alert-danger" role="alert">{error}</div>}

        <button className="btn btn-primary d-grid w-100 mb-3" type="submit" disabled={submitting}>
          {submitting
            ? <span><span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" /> Changement…</span>
            : 'Changer le mot de passe'}
        </button>
      </form>

      <div className="text-center">
        <button type="button" className="btn btn-link p-0" onClick={handleCancel}>
          {user.doit_changer_mdp ? 'Me déconnecter' : 'Annuler et retourner au tableau de bord'}
        </button>
      </div>
    </AuthCard>
  );
}
