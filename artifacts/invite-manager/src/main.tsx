import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const appBase = new URL(import.meta.env.BASE_URL, window.location.origin);
    const workerUrl = new URL('service-worker.js', appBase);
    navigator.serviceWorker.register(workerUrl, { scope: appBase.pathname }).catch((error) => {
      console.warn('Installation hors ligne indisponible', error);
    });
  });
}

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
