import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
// Thème Sneat (ThemeSelection, licence MIT — cf. assets/sneat/LICENSE.md)
import './assets/sneat/vendor/fonts/boxicons.css';
import './assets/sneat/vendor/css/core.css';
import './assets/sneat/vendor/css/theme-default.css';
import './assets/sneat/css/demo.css';
import './assets/sneat/vendor/css/pages/page-auth.css';
import './index.css';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './components/ui';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Mode hors connexion : l'application s'ouvre sans réseau (cf. sw-source.js).
// Uniquement en production : en dev, Vite sert des modules non hashés.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
