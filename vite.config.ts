import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Gemini API key lives only on the server (proxy at /api/gemini); nothing secret is bundled here.
export default defineConfig({
  server: {
    port: 7002,
    host: '0.0.0.0',
    // Own live-reload port, so this copy can run next to the one on 7000 (which uses Vite's default 24678).
    hmr: { port: 24680 },
    allowedHosts: ['mundoscruzados.com','bicho','comic.hcpartners.ch','localhost'],
  },
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        admin: path.resolve(__dirname, 'admin.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    }
  }
});
