import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Gemini API key lives only on the server (proxy at /api/gemini); nothing secret is bundled here.
export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
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
