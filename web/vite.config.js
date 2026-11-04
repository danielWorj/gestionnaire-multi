import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 127.0.0.1 et non localhost : Node résout localhost en IPv6 (::1) alors que
// Flask n'écoute qu'en IPv4, d'où des ECONNREFUSED sur le proxy.
const apiTarget = (process.env.VITE_API_PROXY_TARGET || process.env.VITE_API_BASE_URL || 'http://127.0.0.1:5000').replace(/\/api\/?$/, '');

export default defineConfig({
  plugins: [react()],
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
