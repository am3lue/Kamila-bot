// Kamila: WhatsApp projects (OTP sender or AI chatbot) + the owner's Kamila AI bot.
//
//   gateway/  multi-user WhatsApp projects, /v1 API, widget, webhooks (Supabase)
//   bot/      the owner's personal Kamila bot and its /api dashboard (SQLite)
//   public/   dashboard, sign-in page and the embeddable widget
import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { verifyWebhook } from '@tausi-auth/node';
import { createTausiServer } from '@tausi-auth/js/server';
import logger from './utils/logger.js';
import { createRepo, randomHex } from './gateway/db.js';
import { createAuth } from './gateway/auth.js';
import { createGemini } from './gateway/gemini.js';
import { createSealer } from './gateway/secrets.js';
import { createChatbot } from './gateway/chatbot.js';
import { createWebhookDispatcher } from './gateway/webhooks.js';
import { SessionManager, STATUS } from './gateway/sessions.js';
import { createGatewayRouter } from './gateway/routes.js';
import { newApiKey, newSecret, hashKey } from './gateway/util.js';
import { openBotStore } from './bot/store.js';
import { createKamilaBot } from './bot/kamila.js';
import { createBotRouter } from './bot/routes.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

function envInt(name, dflt, min, max) {
  const n = parseInt(env[name], 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

// ── Configuration ──
const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TAUSI_PUBLISHABLE_KEY', 'TAUSI_SECRET_KEY'].filter((k) => !env[k]?.trim());
if (missing.length) {
  logger.error('Config', `Missing ${missing.join(', ')} (see .env.example)`);
  process.exit(1);
}
const PORT = envInt('PORT', 3000, 1, 65535);
const TAUSI_URL = (env.TAUSI_URL || 'https://auth.tausi.app').replace(/\/+$/, '');
const GEMINI_MODEL = env.GEMINI_MODEL || 'gemini-3.6-flash';
const API_KEY = env.API_KEY || '';
const allowPrivateWebhooks = env.ALLOW_PRIVATE_WEBHOOKS === '1';

// ── Data ──
const repo = createRepo({ url: env.SUPABASE_URL.trim(), serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY.trim() });
try {
  await repo.ping();
} catch (err) {
  logger.error('Config', err.message);
  process.exit(1);
}
const OTP_PEPPER = env.OTP_PEPPER || await repo.getOrCreateSetting('otp_pepper', () => randomHex(32));
const sealer = createSealer(env.ENCRYPTION_KEY || await repo.getOrCreateSetting('encryption_key', () => randomHex(32)));

// The "default" project is the owner's original WhatsApp number running the Kamila bot.
if (!(await repo.getSession('default'))) {
  const k = newApiKey();
  await repo.insertSession({
    id: 'default', owner_id: null, name: 'Kamila', ai_bot: true, auto_start: true,
    api_key_hash: hashKey(k), api_key_prefix: k.slice(0, 12), webhook_secret: newSecret(),
  }).catch((e) => { if (e.dbCode !== '23505') throw e; }); // created by another instance
}
const botStore = openBotStore(env.DB_PATH || './kamila.db');

// ── Services ──
const gemini = createGemini({
  apiKey: env.GEMINI_API_KEY?.trim() || null,
  model: GEMINI_MODEL,
  logger,
  ...(env.GEMINI_BASE_URL ? { baseUrl: env.GEMINI_BASE_URL } : {}),
});
if (!gemini.hasServerKey) logger.warn('Config', 'GEMINI_API_KEY is not set: AI replies need a per-project key');

const auth = createAuth({
  baseUrl: TAUSI_URL,
  secretKey: env.TAUSI_SECRET_KEY,
  ownerEmails: String(env.OWNER_EMAILS || '').split(','),
  ownerPhones: String(env.OWNER_PHONES || '').split(','),
  logger,
});
// Cookie-mode proxy: the browser reaches Tausi through /auth/tausi (no CORS) and
// the session token lives in an HttpOnly cookie.
const tausiServer = createTausiServer({
  baseUrl: TAUSI_URL,
  secretKey: env.TAUSI_SECRET_KEY,
  publishableKey: env.TAUSI_PUBLISHABLE_KEY,
  proxyPath: '/auth/tausi',
  clientIp: (request) => request.headers.get('x-kamila-client-ip'),
});

// ── Live updates (Server-Sent Events) ──
const sseClients = new Map(); // res -> { userId, isOwner }
function sseSend(event, data, canSee) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, viewer] of sseClients) {
    if (canSee(viewer)) { try { res.write(payload); } catch { sseClients.delete(res); } }
  }
}
const emitToOwners = (event, data) => sseSend(event, data, (v) => v.isOwner);
// Project events go to the project's owner; system projects (owner null) to owners.
const emitScoped = (event, { ownerId, ...data }) => sseSend(event, data, (v) => (ownerId == null ? v.isOwner : v.userId === ownerId));

// ── WhatsApp ──
let persona = '';
try {
  persona = readFileSync(join(ROOT, 'prompts/kamila.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
} catch {
  logger.warn('Config', 'prompts/kamila.md not found: the Kamila bot runs without its persona');
}
const kamila = createKamilaBot({ store: botStore, gemini, persona, emit: emitToOwners, cooldownMs: envInt('RATE_LIMIT_COOLDOWN_MS', 2000, 0, 60000) });

const webhooks = createWebhookDispatcher({ repo, logger, allowPrivate: allowPrivateWebhooks });
const chatbot = createChatbot({ repo, gemini, sealer, webhooks, logger });
const sessions = new SessionManager({
  repo,
  webhooks,
  logger,
  puppeteer: {
    headless: env.PUPPETEER_HEADLESS !== 'false',
    args: (env.PUPPETEER_ARGS || '--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage').split(',').map((a) => a.trim()).filter(Boolean),
    executablePath: env.CHROMIUM_PATH || '/usr/bin/chromium',
  },
  authDir: env.WHATSAPP_AUTH_DIR || './.wwebjs_auth',
  onClientCreated: (id, client) => { if (id === 'default') kamila.attach(client); },
  onMessage: (id, client, msg, emit) => chatbot.onMessage(id, client, msg, emit),
});
sessions.on('status', (s) => {
  if (s.id === 'default') kamila.setStatus(s.status, sessions.qr('default'));
  emitScoped('session', s);
});
sessions.on('otp', (o) => emitScoped('otp', o));
sessions.on('chat', (o) => emitScoped('chat', o));

// ── HTTP ──
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY === '1' ? 1 : false);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: VERSION, uptime: Math.round(process.uptime()) }));

// The widget script is embedded on other sites; everything else may not be framed.
app.use((req, res, next) => {
  if (req.path !== '/widget.js') res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.static(join(ROOT, 'public'), { index: false, maxAge: env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use('/vendor/tausi-js', express.static(join(ROOT, 'node_modules/@tausi-auth/js/dist'), { index: false, maxAge: '1d' }));
app.get('/', (_req, res) => res.redirect(302, '/dashboard.html'));

// Cookie-authenticated writes must come from our own pages.
app.use(auth.csrfGuard);

// Tausi sign-in proxy (cookie mode).
app.all('/auth/tausi/*', async (req, res) => {
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || ['x-kamila-client-ip', 'host', 'connection', 'content-length'].includes(k)) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    if (req.ip) headers.set('x-kamila-client-ip', req.ip); // honours TRUST_PROXY, unlike raw X-Forwarded-For
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const out = await tausiServer.proxy(new Request(`${req.protocol}://${req.get('host')}${req.originalUrl}`, {
      method: req.method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
    }));
    res.status(out.status);
    out.headers.forEach((v, k) => { if (k !== 'set-cookie') res.setHeader(k, v); });
    const cookies = out.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.send(Buffer.from(await out.arrayBuffer()));
  } catch (err) {
    logger.error('Auth', `Tausi proxy failed: ${err.message}`);
    res.status(502).json({ error: { code: 'BAD_GATEWAY', message: 'Authentication proxy error' } });
  }
});

app.get('/auth/config', (_req, res) => res.json({ tausiUrl: TAUSI_URL, publishableKey: env.TAUSI_PUBLISHABLE_KEY }));

// EventSource can't send headers, so the dashboard trades its session for a one-time ticket.
app.post('/auth/sse-ticket', auth.requireUser, (req, res) => res.json({ ticket: auth.issueTicket(req.user, req.isOwner) }));

app.get('/api/events', (req, res) => {
  const viewer = auth.redeemTicket(req.query.ticket);
  if (!viewer) return res.status(401).json({ error: 'Invalid or expired ticket' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('\n');
  sseClients.set(res, { userId: viewer.user.id, isOwner: viewer.isOwner });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// Tausi → us: when a Tausi user is deleted, remove their WhatsApp projects.
if (env.TAUSI_WEBHOOK_SECRET) {
  app.post('/webhooks/tausi', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    let event;
    try {
      event = verifyWebhook(env.TAUSI_WEBHOOK_SECRET, req.headers, req.body);
    } catch {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    try {
      if (event.type === 'user.deleted' && event.data?.id) {
        const ids = await repo.sessionIdsForOwner(String(event.data.id));
        for (const id of ids) await sessions.remove(id);
        if (ids.length) logger.info('Auth', `Removed ${ids.length} project(s) of deleted user ${event.data.id}`);
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error('Auth', `Tausi webhook ${event.type} failed: ${err.message}`);
      res.status(500).json({ error: 'Handler failed' }); // Tausi retries
    }
  });
}

// Gateway API: projects, OTP, messages, chat, widget.
app.use('/v1', createGatewayRouter({
  repo,
  manager: sessions,
  webhooks,
  auth,
  logger,
  pepper: OTP_PEPPER,
  chatbot,
  gemini,
  sealer,
  allowPrivateWebhooks,
  maxSessions: envInt('MAX_SESSIONS', 10, 1, 500),
  maxSessionsPerUser: envInt('MAX_SESSIONS_PER_USER', 2, 0, 100),
  rateLimitPerMin: envInt('SESSION_RATE_LIMIT_PER_MIN', 30, 1, 10000),
  chatPerMin: envInt('CHAT_RATE_LIMIT_PER_MIN', 60, 1, 10000),
  widgetPerDay: envInt('WIDGET_MAX_MESSAGES_PER_DAY', 1000, 1, 1000000),
  sendPerRecipientPerMin: envInt('SEND_PER_RECIPIENT_PER_MIN', 5, 1, 1000),
  otp: {
    length: envInt('OTP_LENGTH', 6, 4, 10),
    ttlSeconds: envInt('OTP_TTL_SECONDS', 300, 60, 3600),
    maxAttempts: envInt('OTP_MAX_ATTEMPTS', 5, 1, 20),
    resendCooldownSec: envInt('OTP_RESEND_COOLDOWN_SECONDS', 60, 0, 3600),
    maxPerPhonePerHour: envInt('OTP_MAX_PER_PHONE_PER_HOUR', 5, 1, 100),
  },
}));

// Kamila bot dashboard API: owners only (or x-api-key for scripts).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
app.use('/api', async (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (API_KEY && key && safeEqual(key, API_KEY)) return next();
  try {
    const a = await auth.verify(auth.bearer(req));
    if (!a) return res.status(401).json({ error: 'Sign in required', code: 'unauthenticated' });
    if (!auth.isOwner(a.user)) return res.status(403).json({ error: 'Only owners can use the Kamila bot', code: 'forbidden' });
    next();
  } catch (err) {
    res.status(err.status || 503).json({ error: err.message });
  }
}, createBotRouter({
  store: botStore,
  bot: kamila,
  emit: emitToOwners,
  config: { aiProvider: 'Gemini', modelName: GEMINI_MODEL, aiConfigured: gemini.hasServerKey },
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Start / stop ──
const httpServer = app.listen(PORT, () => logger.info('Server', `Kamila ${VERSION} listening on :${PORT}`));
sessions.startAll().catch((e) => logger.error('Gateway', `Starting projects failed: ${e.message}`));

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info('Server', `${signal}: shutting down`);
  setTimeout(() => process.exit(1), 10000).unref();
  httpServer.close();
  for (const res of sseClients.keys()) { try { res.end(); } catch {} }
  try { await sessions.stopAll(); } catch {}
  try { botStore.db.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// A bug in one handler must not take down every WhatsApp number.
process.on('unhandledRejection', (err) => logger.error('Process', `Unhandled rejection: ${err?.message || err}`));
