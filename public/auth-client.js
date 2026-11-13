// Shared Tausi client for the dashboard and the sign-in page.
import { createTausiClient } from '/vendor/tausi-js/index.js';

let clientPromise = null;

export function getTausi() {
  if (!clientPromise) {
    clientPromise = fetch('/auth/config')
      .then((r) => {
        if (!r.ok) throw new Error('Could not load sign-in settings');
        return r.json();
      })
      // Cookie mode: calls go through this server's /auth/tausi proxy (no CORS) and the
      // session token stays in an HttpOnly cookie that page scripts can't read.
      .then(({ tausiUrl, publishableKey }) => createTausiClient({ baseUrl: tausiUrl, publishableKey, mode: 'cookie', proxyUrl: '/auth/tausi' }));
  }
  return clientPromise;
}

// Only allow same-origin relative paths as a post-sign-in destination.
export function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard.html';
  return raw;
}
