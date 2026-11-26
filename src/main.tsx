import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ensureAnonymousSession, initApiLayer } from './api/client';
import { registerAppShell } from './pwa';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
      refetchOnWindowFocus: true,
    },
  },
});

/**
 * Boot order matters: the API transport (MSW service worker vs in-process
 * adapter) must be decided before the first query fires.
 */
async function boot(): Promise<void> {
  // '/' goes straight to the playable demo; keep `?seed=` for reproducible tests.
  if (window.location.pathname === '/') {
    window.history.replaceState(null, '', `/demo${window.location.search}${window.location.hash}`);
  }
  const mode = await initApiLayer();
  await ensureAnonymousSession();
  // MSW owns the root worker in dev; the PWA worker owns it everywhere else.
  if (import.meta.env.MODE !== 'single' && mode !== 'network') void registerAppShell(__BUILD_ID__);
  const container = document.getElementById('root');
  if (!container) throw new Error('Root element missing');
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

void boot();
