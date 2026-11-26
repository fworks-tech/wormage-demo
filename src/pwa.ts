/** Registers the offline shell. PWA support is optional, so registration never blocks boot. */
export async function registerAppShell(buildId: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const url = new URL('/sw.js', document.baseURI);
  url.searchParams.set('build', buildId);
  try {
    await navigator.serviceWorker.register(url.href, { scope: '/' });
  } catch {
    // A blocked or unsupported worker only removes the offline shell.
  }
}
