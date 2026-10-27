import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The server loads this file as a real ES module (no CommonJS globals), so derive its folder from the URL.
const root = path.dirname(fileURLToPath(import.meta.url));

// The Gemini API key lives only on the server (proxy at /api/gemini); nothing secret is bundled here.
export default defineConfig({
  server: {
    // Default port; PORT in .env.local overrides it (the i18n test copy uses PORT=7002).
    port: 7000,
    host: '0.0.0.0',
    // Live-reload port follows PORT (7000 -> Vite's default 24678), so copies on other ports do not clash.
    hmr: { port: Number(process.env.PORT || 7000) + 17678 },
    allowedHosts: ['mundoscruzados.com','bicho','comic.hcpartners.ch','localhost'],
    // The dev server serves any file under the project root: keep Vite's defaults and add the data folder
    // (comics, invitations, keys, audit log). server.mjs blocks these paths too.
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.data/**'] },
  },
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(root, 'index.html'),
        admin: path.resolve(root, 'admin.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(root, '.'),
    }
  }
});
