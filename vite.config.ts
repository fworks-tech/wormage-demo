import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** Inject the hashed bundles so a production shell is offline-ready on first load. */
// shortcut: outDir is always dist; read it from the resolved Vite config if a custom --outDir is ever used.
function precacheAppShell(outDir: string): void {
  const swPath = join(outDir, 'sw.js');
  const assets = readdirSync(join(outDir, 'assets')).map((file) => `/assets/${file}`);
  const source = readFileSync(swPath, 'utf8');
  if (!source.includes('const ASSETS = [];')) throw new Error('sw.js precache placeholder missing');
  writeFileSync(swPath, source.replace('const ASSETS = [];', `const ASSETS = ${JSON.stringify(assets)};`));
}

/**
 * Two build flavours:
 *  - default: normal Vite build for Vercel with an offline shell service worker
 *  - `--mode single`: one self-contained HTML file (no service worker, in-process API)
 */
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: single ? './' : '/',
    define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
    plugins: [
      react(),
      ...(single
        ? [viteSingleFile({ removeViteModuleLoader: true })]
        : [
            {
              name: 'wormage-pwa-precache',
              apply: 'build' as const,
              closeBundle() {
                precacheAppShell(join(process.cwd(), 'dist'));
              },
            },
          ]),
    ],
    build: {
      target: 'es2020',
      outDir: single ? 'dist-single' : 'dist',
      chunkSizeWarningLimit: 1600,
      assetsInlineLimit: single ? 100_000_000 : 4096,
    },
    server: { port: 5173, host: true },
  };
});
