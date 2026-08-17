import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

/**
 * The local API/websocket port. Kept in one place because the Electron main
 * process, the dev proxy, and the server itself all have to agree on it.
 */
const SERVER_PORT = Number(process.env.TAILS_SERVER_PORT || 4317);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    // Bound to IPv4 loopback explicitly: Vite's default also binds `::1`, which
    // Windows refuses with EACCES on some machines.
    host: '127.0.0.1',
    // Not Vite's usual 5173 — that port falls inside a Windows reserved range
    // (Hyper-V/WSL claim 5161-5260), where bind fails with EACCES even though
    // netstat reports the port free. Check with:
    //   netsh interface ipv4 show excludedportrange protocol=tcp
    port: Number(process.env.TAILS_CLIENT_PORT || 7317),
    strictPort: true,
    proxy: {
      // Proxied rather than called cross-origin so the browser and the packaged
      // Electron build see identical same-origin URLs.
      '/api': { target: `http://127.0.0.1:${SERVER_PORT}`, changeOrigin: true },
      /*
        Every websocket the renderer opens has to be listed here, and the cost
        of forgetting one is worse than it sounds.

        `/voice` was missing. In a packaged build the renderer is served by the
        same Express server that answers the socket, so the path resolves and
        dictation works; under `npm run dev` the renderer is served by Vite on a
        different port, the handshake goes nowhere, and dictation produces
        nothing at all. Meanwhile `/api/voice/status` *is* proxied, so the
        feature reports itself ready, the button enables, the microphone opens
        and the level meter moves. Everything says it is working except the
        text.

        `proxy-paths.test.ts` now reads this file and the renderer's own
        `new WebSocket(...)` calls and fails if they disagree.
      */
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
      '/shell': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
      '/voice': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
