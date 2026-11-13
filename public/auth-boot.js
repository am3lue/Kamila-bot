// Runs before the dashboard: makes sure someone is signed in with Tausi,
// exposes window.KamilaAuth, then loads the dashboard scripts in order.
import { getTausi } from './auth-client.js';

function toLogin() {
  const next = location.pathname + location.hash;
  location.replace('/login.html?next=' + encodeURIComponent(next));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.body.appendChild(s);
  });
}

async function boot() {
  let tausi;
  try {
    tausi = await getTausi();
    await tausi.initialize();
  } catch (err) {
    document.getElementById('boot-msg').textContent = 'Sign-in service unavailable: ' + err.message;
    return;
  }
  if (tausi.getState().status !== 'signedIn') return toLogin();

  // Cookie mode: the browser sends the HttpOnly session cookie with every same-origin request.
  const res = await fetch('/v1/account');
  if (res.status === 401) { await tausi.signOut().catch(() => {}); return toLogin(); }
  if (!res.ok) {
    document.getElementById('boot-msg').textContent = 'Could not load your account (HTTP ' + res.status + ').';
    return;
  }
  const account = await res.json();

  let signingOut = false;
  window.KamilaAuth = {
    user: account.user,
    isOwner: account.isOwner,
    limits: account.limits,
    async headers(extra) {
      return { ...(extra || {}) };
    },
    // Called by the dashboard on any 401 from our server.
    async expired() {
      if (signingOut) return;
      signingOut = true;
      await tausi.signOut().catch(() => {});
      toLogin();
    },
    async signOut() {
      signingOut = true;
      await tausi.signOut().catch(() => {});
      location.replace('/login.html');
    },
  };
  tausi.subscribe((s) => { if (s.status === 'signedOut' && !signingOut) toLogin(); });

  document.body.classList.toggle('is-owner', account.isOwner);
  const who = document.getElementById('user-chip');
  if (who) {
    who.querySelector('.user-name').textContent = account.user.name || account.user.email;
    who.querySelector('.user-email').textContent = account.user.email;
    who.querySelector('.user-signout').onclick = () => window.KamilaAuth.signOut();
  }
  document.getElementById('boot-screen')?.remove();

  await loadScript('/dashboard.js');
  await loadScript('/gateway.js');
  window.KamilaDash?.start();
}

boot();
