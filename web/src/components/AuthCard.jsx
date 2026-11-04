import { useState } from 'react';

// Gabarit des pages d'authentification Sneat (auth-login-basic.html).
export default function AuthCard({ title, subtitle, children }) {
  return (
    <div className="container-xxl">
      <div className="authentication-wrapper authentication-basic container-p-y">
        <div className="authentication-inner">
          <div className="card">
            <div className="card-body">
              <div className="app-brand justify-content-center">
                <span className="app-brand-link gap-2">
                  <span className="app-brand-logo demo">
                    <i className="bx bxs-graduation" />
                  </span>
                  <span className="app-brand-text demo text-body fw-bolder">Gestionnaire</span>
                </span>
              </div>
              <h4 className="mb-2">{title}</h4>
              {subtitle && <p className="mb-4">{subtitle}</p>}
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Champ mot de passe avec l'œil afficher/masquer (form-password-toggle de Sneat).
// inputMode/maxLength/inputClassName : variante code PIN (cf. PinInput).
export function PasswordInput({ id, name, value, onChange, minLength, maxLength, autoFocus, placeholder = '············', autoComplete, inputMode, inputClassName = '', inputRef }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="input-group input-group-merge">
      <input
        type={visible ? 'text' : 'password'}
        id={id}
        name={name}
        ref={inputRef}
        className={`form-control ${inputClassName}`}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        minLength={minLength}
        maxLength={maxLength}
        inputMode={inputMode}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        required
      />
      <span
        className="input-group-text cursor-pointer"
        onClick={() => setVisible((current) => !current)}
        role="button"
        aria-label={visible ? 'Masquer la saisie' : 'Afficher la saisie'}
      >
        <i className={`bx ${visible ? 'bx-show' : 'bx-hide'}`} />
      </span>
    </div>
  );
}

// Saisie d'un code PIN à 4 chiffres : clavier numérique sur téléphone,
// chiffres uniquement. onValue reçoit la valeur nettoyée.
export function PinInput({ id, name, value, onValue, autoFocus, autoComplete = 'current-password', inputRef }) {
  return (
    <PasswordInput
      id={id}
      name={name}
      value={value}
      onChange={(event) => onValue(event.target.value.replace(/\D/g, '').slice(0, 4))}
      maxLength={4}
      inputMode="numeric"
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      placeholder="••••"
      inputClassName="saisie-code"
      inputRef={inputRef}
    />
  );
}
