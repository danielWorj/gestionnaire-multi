import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AuthCard, { PasswordInput, PinInput } from '../components/AuthCard';
import LoadingScreen from '../components/LoadingScreen';
import { useToast } from '../components/ui';

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

// Miroir de pin_est_faible() côté backend : chiffres identiques, suite
// (1234, 9876), motif répété (1212), colonne du clavier (2580).
function pinFaible(pin) {
  const chiffres = [...pin].map(Number);
  const ecarts = new Set(chiffres.slice(1).map((c, i) => c - chiffres[i]));
  return new Set(chiffres).size === 1
    || (ecarts.size === 1 && (ecarts.has(1) || ecarts.has(-1)))
    || pin.slice(0, 2) === pin.slice(2)
    || pin === '2580' || pin === '0852';
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

// Utilisateur d'établissement : change son code PIN (4 chiffres), quand il
// le souhaite, depuis son espace (menu du profil → « Changer mon code PIN »).
// SuperAdmin : change son mot de passe.
export default function ChangePasswordPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user, loading, changePassword, logout, isSuperAdmin } = useAuth();
  const [form, setForm] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null); // { message, to } une fois le changement fait (SuperAdmin)

  if (loading) {
    return <LoadingScreen />;
  }

  if (!user) {
    // SuperAdmin : après succès, changePassword() a vidé la session.
    return <Navigate to={done?.to || '/login'} replace state={done ? { message: done.message } : undefined} />;
  }

  const modePin = !isSuperAdmin;
  const rules = evaluatePassword(form.newPassword);
  const score = [rules.length, rules.letter, rules.digit].filter(Boolean).length;
  const strengthPct = form.newPassword.length === 0 ? 0 : (score / 3) * 100;
  const strengthColor = score <= 1 ? 'bg-danger' : score === 2 ? 'bg-warning' : 'bg-success';
  const pinComplet = form.newPassword.length === 4;
  const pinOk = pinComplet && !pinFaible(form.newPassword);
  const matches = form.confirmPassword === form.newPassword;

  const handleChange = (event) => {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  };
  const setPin = (name) => (value) => setForm((current) => ({ ...current, [name]: value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.oldPassword || !form.newPassword || !form.confirmPassword) {
      setError('Veuillez renseigner les trois champs.');
      return;
    }
    if (modePin && !pinOk) {
      setError(pinComplet
        ? 'Ce PIN est trop facile à deviner (ex : 0000, 1234, 1212). Choisissez-en un autre.'
        : 'Le nouveau PIN doit contenir exactement 4 chiffres.');
      return;
    }
    if (!modePin && !(rules.length && rules.letter && rules.digit)) {
      setError('Le nouveau mot de passe doit contenir au moins 8 caractères, une lettre et un chiffre.');
      return;
    }
    if (!matches) {
      setError(modePin ? 'La confirmation ne correspond pas au nouveau PIN.' : 'La confirmation ne correspond pas au nouveau mot de passe.');
      return;
    }
    if (form.oldPassword === form.newPassword) {
      setError(modePin ? "Le nouveau PIN doit être différent de l'actuel." : "Le nouveau mot de passe doit être différent de l'ancien.");
      return;
    }

    setSubmitting(true);
    try {
      if (modePin) {
        // La session continue : on rejoint directement l'espace de travail.
        await changePassword(form);
        toast('PIN modifié. Utilisez-le à votre prochaine connexion.');
        navigate('/', { replace: true });
        return;
      }
      setDone({ to: '/superadmin/login', message: 'Mot de passe modifié. Reconnectez-vous avec votre nouveau mot de passe.' });
      await changePassword(form);
    } catch (submitError) {
      setDone(null);
      setError(submitError.message || (modePin ? 'Impossible de modifier le PIN.' : 'Impossible de modifier le mot de passe.'));
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
      title={modePin ? 'Changer mon code PIN 🔒' : 'Changer le mot de passe 🔒'}
      subtitle={user.doit_changer_mdp
        ? 'Votre PIN doit être remplacé par un PIN que vous seul connaissez.'
        : modePin ? 'Choisissez un nouveau code PIN de 4 chiffres.' : 'Choisissez un nouveau mot de passe pour sécuriser votre compte.'}
    >
      {user.doit_changer_mdp && (
        <div className="alert alert-warning d-flex align-items-center gap-2 py-2" role="alert">
          <i className="bx bx-error" />
          <span>Le changement de PIN est obligatoire avant de continuer.</span>
        </div>
      )}

      <div className="d-flex align-items-center gap-2 mb-3 p-2 border rounded">
        <div className="avatar">
          <span className="avatar-initial rounded-circle bg-label-primary">{initials(user.nom)}</span>
        </div>
        <div>
          <div className="fw-semibold">{user.nom || '—'}</div>
          <small className="text-muted">
            {modePin ? <>Code de connexion : <span className="font-monospace fw-semibold">{user.code_connexion || '—'}</span></> : (user.email || '—')}
          </small>
        </div>
      </div>

      <form className="mb-3" onSubmit={handleSubmit} noValidate>
        {modePin ? (
          <>
            <div className="mb-3 form-password-toggle">
              <label className="form-label" htmlFor="oldPassword">PIN actuel</label>
              <PinInput id="oldPassword" name="oldPassword" value={form.oldPassword} onValue={setPin('oldPassword')} autoFocus />
            </div>

            <div className="mb-2 form-password-toggle">
              <label className="form-label" htmlFor="newPassword">Nouveau PIN</label>
              <PinInput id="newPassword" name="newPassword" value={form.newPassword} onValue={setPin('newPassword')} autoComplete="new-password" />
            </div>

            <ul className="list-unstyled small mb-3">
              <Rule ok={pinComplet}>Exactement 4 chiffres</Rule>
              <Rule ok={pinOk}>Pas trop facile à deviner (pas de 0000, 1234, 1212…)</Rule>
            </ul>

            <div className="mb-3 form-password-toggle">
              <label className="form-label" htmlFor="confirmPassword">Confirmer le nouveau PIN</label>
              <PinInput id="confirmPassword" name="confirmPassword" value={form.confirmPassword} onValue={setPin('confirmPassword')} autoComplete="new-password" />
              {form.confirmPassword.length === 4 && (
                <small className={`d-block mt-1 ${matches ? 'text-success' : 'text-danger'}`}>
                  <i className={`bx ${matches ? 'bx-check-circle' : 'bx-x-circle'} me-1`} />
                  {matches ? 'Les PIN correspondent' : 'Les PIN ne correspondent pas'}
                </small>
              )}
            </div>
          </>
        ) : (
          <>
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
          </>
        )}

        <div className="alert alert-info d-flex gap-2 small py-2" role="note">
          <i className="bx bx-info-circle" />
          <span>{modePin
            ? 'Retenez bien ce PIN : il vous sera demandé à chaque connexion. Ne le communiquez à personne. En cas d’oubli, l’administrateur peut le réinitialiser.'
            : 'Pour votre sécurité, vous serez déconnecté(e) après ce changement et devrez vous reconnecter avec votre nouveau mot de passe.'}</span>
        </div>

        {error && <div className="alert alert-danger" role="alert">{error}</div>}

        <button className="btn btn-primary d-grid w-100 mb-3" type="submit" disabled={submitting}>
          {submitting
            ? <span><span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" /> Changement…</span>
            : modePin ? 'Changer mon PIN' : 'Changer le mot de passe'}
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
