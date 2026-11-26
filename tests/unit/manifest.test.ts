import { readFileSync, existsSync } from 'node:fs';
import { expect, test } from 'vitest';

/** Read a file relative to the repo root (this test lives in tests/unit). */
const read = (path: string): Buffer => readFileSync(new URL(`../../${path}`, import.meta.url));

const readManifest = () =>
  JSON.parse(read('public/manifest.webmanifest').toString('utf8')) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    orientation: string;
    background_color: string;
    theme_color: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  };

const pngSize = (bytes: Buffer) => {
  expect(bytes.subarray(0, 8).toString('hex'), 'PNG signature').toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

test('the manifest launches the demo as a standalone home-screen app', () => {
  const manifest = readManifest();
  expect(manifest.name).toBe('Wormage');
  expect(manifest.short_name).toBe('Wormage');
  expect(manifest.start_url).toBe('/demo');
  expect(manifest.scope).toBe('/');
  expect(manifest.display).toBe('standalone');
  expect(manifest.orientation).toBe('landscape');
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);

  const purposes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
  expect(purposes).toContain('192x192:any');
  expect(purposes).toContain('512x512:any');
  expect(purposes).toContain('512x512:maskable');
});

test('every manifest icon exists at its declared size', () => {
  for (const icon of readManifest().icons) {
    const file = `public${icon.src}`;
    expect(existsSync(new URL(`../../${file}`, import.meta.url)), file).toBe(true);
    const [width, height] = icon.sizes.split('x').map(Number);
    expect(pngSize(read(file)), file).toEqual({ width, height });
    expect(icon.type).toBe('image/png');
  }

  const apple = pngSize(read('public/icons/apple-touch-icon.png'));
  expect(apple).toEqual({ width: 180, height: 180 });
});

test('index.html wires the manifest, icons and iOS title', () => {
  const html = read('index.html').toString('utf8');
  expect(html).toContain('rel="manifest"');
  expect(html).toContain('href="/manifest.webmanifest"');
  expect(html).toContain('rel="apple-touch-icon"');
  expect(html).toContain('href="/icons/apple-touch-icon.png"');
  expect(html).toContain('name="apple-mobile-web-app-title"');

  for (const [, href] of html.matchAll(/href="(\/icons\/[^"]+)"/g)) {
    expect(existsSync(new URL(`../../public${href}`, import.meta.url)), href).toBe(true);
  }
});

test('the app service worker caches the shell but never API traffic', () => {
  const source = read('public/sw.js').toString('utf8');
  expect(source).toContain("url.pathname.startsWith('/api/')");
  expect(source).toContain("url.pathname === '/mockServiceWorker.js'");
  expect(source).toContain('self.skipWaiting()');
  expect(source).toContain('self.clients.claim()');
  expect(source.indexOf("url.pathname.startsWith('/api/')")).toBeLessThan(source.indexOf('cache.put(request'));
});

test('every precached shell entry resolves to a shipped file', () => {
  // cache.addAll is all-or-nothing: one missing icon breaks the whole install.
  const source = read('public/sw.js').toString('utf8');
  const start = source.indexOf('const SHELL = [');
  const shell = source.slice(start, source.indexOf('];', start));
  for (const [, path] of shell.matchAll(/'(\/[^']*)'/g)) {
    // Route entries are served as index.html by the SPA fallback.
    const file = path === '/' || path === '/demo' || path === '/index.html' ? 'index.html' : `public${path}`;
    expect(existsSync(new URL(`../../${file}`, import.meta.url)), path).toBe(true);
  }
});

test('Vercel serves the service worker as a live script', () => {
  const config = JSON.parse(read('vercel.json').toString('utf8')) as {
    rewrites: Array<{ source: string }>;
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  expect(config.rewrites[0].source).toContain('sw\\.js');
  const swHeaders = config.headers.find((entry) => entry.source === '/sw.js');
  expect(swHeaders).toBeDefined();
  expect(swHeaders?.headers).toEqual(
    expect.arrayContaining([{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }]),
  );
});
