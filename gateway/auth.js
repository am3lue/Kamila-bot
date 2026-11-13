// Tausi Auth integration: verifies dashboard/API sign-ins and decides who is
// an owner (may see the Kamila AI bot and the system "default" session).
import crypto from 'crypto';
import { TausiBackend, isTausiError } from '@tausi-auth/node';
import { sha256 } from './util.js';

const CACHE_OK_MS = 30_000;   // a revoked session can be accepted for at most this long
const CACHE_BAD_MS = 5_000;
const TICKET_MS = 60_000;

export const SESSION_COOKIE = 'tausi_session'; // set by the Tausi cookie-mode proxy (/auth/tausi)

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

export function createAuth({ baseUrl, secretKey, ownerEmails = [], ownerPhones = [], logger }) {
  const tausi = new TausiBackend({ baseUrl, secretKey, timeoutMs: 8000 });
  const owners = new Set(ownerEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const digits = (p) => String(p || '').replace(/[^0-9]/g, '');
  const ownerPhoneSet = new Set(ownerPhones.map(digits).filter((d) => d.length >= 7));
  const cache = new Map(); // sha256(token) -> { auth, exp }
  const tickets = new Map(); // ticket -> { user, isOwner, exp }

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache) if (v.exp < now) cache.delete(k);
    for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
  }, 60_000).unref();

  function isOwner(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (user.emailVerified && owners.has(String(user.email || '').toLowerCase())) return true;
    return !!user.phoneNumberVerified && ownerPhoneSet.has(digits(user.phoneNumber));
  }

  // Returns { user, session } or null. Throws (status 503) only when Tausi is unreachable.
  async function verify(token) {
    if (!token || typeof token !== 'string' || token.length > 4096) return null;
    const key = sha256(token);
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.auth;
    let auth;
    try {
      auth = await tausi.verifySession(token);
    } catch (err) {
      logger.error('Auth', `Tausi verify failed: ${isTausiError(err) ? `${err.code} (${err.status})` : err.message}`);
      const e = new Error('Authentication service unavailable, try again shortly');
      e.status = 503;
      throw e;
    }
    if (cache.size > 5000) cache.clear();
    cache.set(key, { auth, exp: Date.now() + (auth ? CACHE_OK_MS : CACHE_BAD_MS) });
    return auth;
  }

  // The credential for this request: an Authorization bearer (API keys, scripts)
  // or, for the dashboard, the HttpOnly Tausi session cookie.
  function bearer(req) {
    const h = req.headers.authorization || '';
    if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
    return readCookie(req.headers.cookie, SESSION_COOKIE) || '';
  }

  // Cookies are sent automatically, so cookie-authenticated writes must come from our own pages.
  function csrfGuard(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers.authorization || !readCookie(req.headers.cookie, SESSION_COOKIE)) return next();
    if (req.headers['sec-fetch-site'] === 'same-origin') return next();
    const origin = req.headers.origin;
    let ok = false;
    try { ok = !!origin && new URL(origin).host === req.headers.host; } catch {}
    if (ok) return next();
    res.status(403).json({ error: 'Cross-site request refused', code: 'csrf_rejected' });
  }

  // Express middleware: any signed-in Tausi user.
  function requireUser(req, res, next) {
    verify(bearer(req)).then((auth) => {
      if (!auth) return res.status(401).json({ error: 'Sign in required', code: 'unauthenticated' });
      req.user = auth.user;
      req.isOwner = isOwner(auth.user);
      next();
    }, (err) => res.status(err.status || 503).json({ error: err.message }));
  }

  // One-time, short-lived ticket so EventSource (which can't send headers) can authenticate.
  function issueTicket(user, owner) {
    const t = crypto.randomBytes(24).toString('base64url');
    tickets.set(t, { user, isOwner: owner, exp: Date.now() + TICKET_MS });
    return t;
  }
  function redeemTicket(t) {
    const v = t && tickets.get(String(t));
    if (!v) return null;
    tickets.delete(String(t));
    return v.exp > Date.now() ? v : null;
  }

  return { tausi, verify, isOwner, bearer, csrfGuard, requireUser, issueTicket, redeemTicket };
}
