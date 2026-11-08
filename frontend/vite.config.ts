import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies the backend so the browser only ever talks to one origin.
// That keeps cookies/WebSocket same-origin and means the backend needs no CORS
// configuration at all.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Every empty-state illustration is 1.6-4.7 KB, i.e. under Vite's 4 KB
    // inline limit, so five of the six would ship as base64 inside the JS bundle:
    // bigger over the wire, no separate cache entry, no hashed URL. Emit files.
    assetsInlineLimit: 0,
  },
});
