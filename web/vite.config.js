import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Génère dist/sw.js (mode hors connexion) à partir de sw-source.js, avec la
// liste exacte des fichiers du build à garder sur l'appareil. La version
// (hash de cette liste) change à chaque build : l'ancien cache est purgé.
const FICHIERS_PUBLICS = ['/index.html', '/manifest.webmanifest', '/app-icon.svg', '/app-icon-192.png', '/app-icon-512.png', '/apple-touch-icon.png', '/favicon.svg'];

function serviceWorker() {
  return {
    name: 'service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const fichiers = Object.keys(bundle).filter((f) => !f.endsWith('.map')).map((f) => `/${f}`);
      const precache = [...new Set([...fichiers, ...FICHIERS_PUBLICS])].sort();
      const version = createHash('sha256').update(precache.join(',')).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./sw-source.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// 127.0.0.1 et non localhost : Node résout localhost en IPv6 (::1) alors que
// Flask n'écoute qu'en IPv4, d'où des ECONNREFUSED sur le proxy.
const apiTarget = (process.env.VITE_API_PROXY_TARGET || process.env.VITE_API_BASE_URL || 'http://127.0.0.1:5000').replace(/\/api\/?$/, '');

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
