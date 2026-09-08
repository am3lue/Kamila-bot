import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import { EventEmitter } from 'events';
import logger from './utils/logger.js';
import { initMemoryTable, prepareMemoryStmts, buildMemoryContext, maybeUpdateMemory, getMemoryStats } from './utils/memory.js';
import { formatForWhatsApp, enforceWordCap } from './utils/markdown.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const {
  PORT = 3000,
  OLLAMA_URL = 'http://localhost:11434/api/chat',
  MODEL_NAME = 'kamila',
  AXIOS_TIMEOUT_MS = 30000,
  RATE_LIMIT_COOLDOWN_MS = 2000,
  PUPPETEER_HEADLESS = 'true',
  PUPPETEER_ARGS = '--no-sandbox,--disable-setuid-sandbox',
  DB_PATH = './kamila.db',
  // Access lists disabled (kept for recovery).
  // WHITELIST = '',
  // BLACKLIST = '',
} = process.env;

const MAX_MSG_LEN = 2000;
const MAX_WHATSAPP_LEN = 4000;

// Handoff messages used when a chat is flagged needs-human-help (AI stays paused until resolved)
const HANDOFF_EN = 'Sorry Pal Cant Continue, let Him Resolve this ...';
const HANDOFF_SW = 'Samahani Siwezi Kukusaidia, Suburi Anakuja Kukusaidia';
const HANDOFF_RESEND_MS = 10 * 60 * 1000; // re-send handoff at most once per 10 min while paused
const swahiliHints = ['niambie', 'mambo', 'vipi', 'mzee', 'habari', 'sawa', 'poa', 'pole', 'rafiki', 'kaka', 'dada', 'nini', 'hapana', 'ndio', 'asante', 'karibu', 'kesho', 'leo', 'yaani', 'kweli', 'sasa', 'kwa', 'nimechoka', 'nimekasirika', 'wewe', 'mimi', 'unataka', 'usijali', 'sina', 'nikoe', 'hapa', 'tafadhali'];
const pausedHandoffSent = new Map(); // chatId -> last handoff timestamp

// ── Database ──

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    phone_number TEXT PRIMARY KEY,
    name TEXT,
    auto_reply_mode TEXT CHECK(auto_reply_mode IN ('AUTO','DRAFT','OFF')) DEFAULT 'AUTO',
    wa_name TEXT,
    on_whatsapp INTEGER DEFAULT 1,
    registered INTEGER DEFAULT 0,
    source TEXT DEFAULT 'import'
  );
  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL UNIQUE,
    submitted_name TEXT,
    status TEXT CHECK(status IN ('PENDING','APPROVED','REJECTED')) DEFAULT 'PENDING',
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    sender TEXT,
    text TEXT,
    timestamp INTEGER DEFAULT (unixepoch()),
    is_ai INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    task_description TEXT,
    urgency TEXT CHECK(urgency IN ('HIGH','MEDIUM','LOW')) DEFAULT 'MEDIUM',
    status TEXT CHECK(status IN ('PENDING','DONE')) DEFAULT 'PENDING',
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS evaluations (
    chat_id TEXT PRIMARY KEY,
    resolution_score INTEGER CHECK(resolution_score BETWEEN 1 AND 10),
    sentiment TEXT,
    needs_human_help INTEGER DEFAULT 0,
    summary TEXT,
    last_updated INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    to_number TEXT,
    text TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message_ts INTEGER,
    rating INTEGER CHECK(rating IN (-1, 1)),
    comment TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
`);
// ── Idempotent migration: add columns to existing contacts table ──
(function migrateContactsColumns() {
  try {
    const cols = db.prepare(`PRAGMA table_info(contacts)`).all().map((c) => c.name);
    const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE contacts ADD COLUMN ${ddl}`); };
    add('wa_name', `wa_name TEXT`);
    add('on_whatsapp', `on_whatsapp INTEGER DEFAULT 1`);
    add('registered', `registered INTEGER DEFAULT 0`);
    add('source', `source TEXT DEFAULT 'import'`);
  } catch (err) {
    console.error('Migration failed (contacts columns):', err.message);
  }
})();
// ── Set existing never-chatted contacts to OFF (per host: all contacts OFF until engaged) ──
(function migrateNeverChattedToOff() {
  try {
    db.exec(`UPDATE contacts SET auto_reply_mode = 'OFF' WHERE auto_reply_mode = 'AUTO' AND phone_number NOT IN (SELECT DISTINCT chat_id FROM messages)`);
  } catch (err) {
    console.error('Migration failed (OFF default):', err.message);
  }
})();
// ── Ensure UNIQUE on registrations.chat_id so ON CONFLICT(chat_id) resolves ──
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_chat ON registrations(chat_id)`);
initMemoryTable(db);
const memStmts = prepareMemoryStmts(db);

const stmts = {
  upsertContact: db.prepare(`INSERT INTO contacts (phone_number, name, source, on_whatsapp) VALUES (?, ?, 'import', 1) ON CONFLICT(phone_number) DO UPDATE SET name = CASE WHEN excluded.name = '' THEN contacts.name ELSE excluded.name END`),
  upsertContactBatch: db.prepare(`INSERT INTO contacts (phone_number, name) VALUES (@phone, @name) ON CONFLICT(phone_number) DO UPDATE SET name = CASE WHEN excluded.name = '' THEN contacts.name ELSE excluded.name END`),
  upsertContactFromChat: db.prepare(`INSERT INTO contacts (phone_number, name, source, on_whatsapp, auto_reply_mode) VALUES (?, ?, 'chat', 1, 'AUTO') ON CONFLICT(phone_number) DO UPDATE SET name = CASE WHEN excluded.name = '' THEN contacts.name ELSE excluded.name END`),
  getContact: db.prepare(`SELECT * FROM contacts WHERE phone_number = ?`),
  setContactMode: db.prepare(`UPDATE contacts SET auto_reply_mode = ? WHERE phone_number = ?`),
  setOnWhatsapp: db.prepare(`UPDATE contacts SET on_whatsapp = ? WHERE phone_number = ?`),
  setWaName: db.prepare(`UPDATE contacts SET wa_name = ?, name = CASE WHEN ? = '' THEN name ELSE ? END WHERE phone_number = ?`),
  dropContact: db.prepare(`DELETE FROM contacts WHERE phone_number = ?`),
  // Access control (whitelist / blacklist) — DISABLED, kept for recovery.
  // getAccessType: db.prepare(`SELECT list_type FROM access WHERE phone_number = ?`),
  // getWhitelist: db.prepare(`SELECT phone_number FROM access WHERE list_type = 'WHITELIST' ORDER BY phone_number`),
  // getBlacklist: db.prepare(`SELECT phone_number FROM access WHERE list_type = 'BLACKLIST' ORDER BY phone_number`),
  // allAccess: db.prepare(`SELECT phone_number, list_type FROM access ORDER BY list_type, phone_number`),
  // getWhitelistCount: db.prepare(`SELECT COUNT(*) AS n FROM access WHERE list_type = 'WHITELIST'`),
  // addAccess: db.prepare(`INSERT INTO access (phone_number, list_type) VALUES (?, ?) ON CONFLICT(phone_number) DO UPDATE SET list_type = excluded.list_type`),
  // addAccessIfMissing: db.prepare(`INSERT INTO access (phone_number, list_type) VALUES (?, ?) ON CONFLICT(phone_number) DO NOTHING`),
  // removeAccess: db.prepare(`DELETE FROM access WHERE phone_number = ?`),
  // clearAccess: db.prepare(`DELETE FROM access WHERE list_type = ?`),
  // Registration
  insertRegistration: db.prepare(`INSERT INTO registrations (chat_id, submitted_name, status) VALUES (?, ?, 'PENDING') ON CONFLICT(chat_id) DO UPDATE SET submitted_name = excluded.submitted_name, status = 'PENDING'`),
  getPendingRegistrations: db.prepare(`SELECT * FROM registrations WHERE status = 'PENDING' ORDER BY created_at ASC`),
  getRegistration: db.prepare(`SELECT * FROM registrations WHERE chat_id = ?`),
  approveRegistration: db.prepare(`UPDATE registrations SET status = 'APPROVED' WHERE chat_id = ?`),
  rejectRegistration: db.prepare(`UPDATE registrations SET status = 'REJECTED' WHERE chat_id = ?`),
  registerContact: db.prepare(`UPDATE contacts SET registered = 1 WHERE phone_number = ?`),
  insertMessage: db.prepare(`INSERT INTO messages (chat_id, sender, text, is_ai) VALUES (?, ?, ?, ?)`),
  deleteMessagesByChat: db.prepare(`DELETE FROM messages WHERE chat_id = ?`),
  getMessages: db.prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 50`),
  getContactMessages: db.prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC`),
  getAllContacts: db.prepare(`SELECT * FROM contacts ORDER BY name ASC, phone_number ASC`),
  getChattedContacts: db.prepare(`SELECT c.*, MAX(m.timestamp) AS last_message_ts FROM contacts c JOIN messages m ON m.chat_id = c.phone_number GROUP BY c.phone_number ORDER BY last_message_ts DESC, c.name ASC`),
  getAllMessages: db.prepare(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT 200`),
  insertTask: db.prepare(`INSERT INTO tasks (chat_id, task_description, urgency) VALUES (?, ?, ?)`),
  getTasks: db.prepare(`SELECT * FROM tasks WHERE status = 'PENDING' ORDER BY CASE urgency WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`),
  getAllTasks: db.prepare(`SELECT * FROM tasks ORDER BY CASE urgency WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`),
  completeTask: db.prepare(`UPDATE tasks SET status = 'DONE' WHERE id = ?`),
  upsertEvaluation: db.prepare(`INSERT OR REPLACE INTO evaluations (chat_id, resolution_score, sentiment, needs_human_help, summary, last_updated) VALUES (?, ?, ?, ?, ?, unixepoch())`),
  resolveEvaluation: db.prepare(`UPDATE evaluations SET needs_human_help = 0, last_updated = unixepoch() WHERE chat_id = ?`),
  getEvaluation: db.prepare(`SELECT * FROM evaluations WHERE chat_id = ?`),
  getAllEvaluations: db.prepare(`SELECT * FROM evaluations ORDER BY last_updated DESC`),
  getChatsNeedingHelp: db.prepare(`SELECT * FROM evaluations WHERE needs_human_help = 1`),
  // Stats queries
  countTable: (table) => {
    const allowed = new Set(['contacts', 'messages', 'tasks', 'evaluations', 'drafts']);
    if (!allowed.has(table)) throw new Error(`Invalid table: ${table}`);
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  },
  countAiMessages: () => db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE is_ai = 1`).get().n,
  countOpenTasks: () => db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'PENDING'`).get().n,
  volumeTrend: db.prepare(`SELECT date(timestamp, 'unixepoch') AS day, COUNT(*) AS messages, SUM(is_ai) AS ai FROM messages GROUP BY day ORDER BY day DESC LIMIT 14`),
  sentimentMix: db.prepare(`SELECT sentiment, COUNT(*) AS n FROM evaluations GROUP BY sentiment`),
  modeMix: db.prepare(`SELECT auto_reply_mode AS mode, COUNT(*) AS n FROM contacts GROUP BY auto_reply_mode`),
  avgScore: db.prepare(`SELECT AVG(resolution_score) AS avg FROM evaluations`),
  // Drafts
  insertDraft: db.prepare(`INSERT INTO drafts (chat_id, to_number, text) VALUES (?, ?, ?)`),
  getDrafts: db.prepare(`SELECT * FROM drafts ORDER BY created_at DESC`),
  getDraftsByChat: db.prepare(`SELECT * FROM drafts WHERE chat_id = ? ORDER BY created_at DESC`),
  getDraftById: db.prepare(`SELECT * FROM drafts WHERE id = ?`),
  deleteDraft: db.prepare(`DELETE FROM drafts WHERE id = ?`),
  deleteDraftsByChat: db.prepare(`DELETE FROM drafts WHERE chat_id = ?`),
  // Feedback
  insertFeedback: db.prepare(`INSERT INTO feedback (chat_id, message_ts, rating, comment) VALUES (?, ?, ?, ?)`),
  getFeedbackByChat: db.prepare(`SELECT * FROM feedback WHERE chat_id = ? ORDER BY created_at DESC`),
  getFeedbackStats: db.prepare(`SELECT chat_id, COUNT(*) AS count, SUM(rating) AS total, AVG(rating) AS avg_rating FROM feedback GROUP BY chat_id`),
  getAllFeedback: db.prepare(`SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100`),
  // Messages for memory counting
  countMessages: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`),
};

// ── Access control (whitelist / blacklist) ──

// Canonical phone form: digits only, international format, no separators or
// WhatsApp ID suffixes (@c.us/@lid/@g.us/@s.whatsapp.net). Used for BOTH
// lookups and storage so whitelist/blacklist actually match inbound IDs.
function canonicalPhone(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim()
    .replace(/@c\.us$|@lid$|@g\.us$|@s\.whatsapp\.net$/i, '')
    .replace(/[^0-9]/g, '');
  return cleaned.length >= 7 ? cleaned : null;
}

// Seed access table from env boot defaults (add-only, doesn't override
// dashboard-managed entries). — DISABLED (access control removed).
// (function seedAccessFromEnv() {
//   const seed = (list, type) => {
//     for (const raw of String(list).split(',')) {
//       const phone = canonicalPhone(raw);
//       if (phone) stmts.addAccessIfMissing.run(phone, type);
//     }
//   };
//   seed(WHITELIST, 'WHITELIST');
//   seed(BLACKLIST, 'BLACKLIST');
// })();

// Precedence: blacklist always wins. Otherwise, if a whitelist is active
// (non-empty), only whitelisted numbers are allowed. With an empty whitelist
// everyone not blacklisted is allowed.
// — DISABLED (access control removed; per-contact Auto/Off/Draft is the control).
// function accessAllowed(chatId) {
//   const phone = canonicalPhone(chatId);
//   if (!phone) return false;
//   const row = stmts.getAccessType.get(phone);
//   if (row?.list_type === 'BLACKLIST') return false;
//   if (row?.list_type === 'WHITELIST') return true;
//   return stmts.getWhitelistCount.get().n === 0;
// }

// ── SSE Infrastructure ──

const sseBus = new EventEmitter();
sseBus.setMaxListeners(50);
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ── Express ──

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.get('/', (_req, res) => res.redirect(302, '/dashboard.html'));

// ── Security Headers ──
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ── API Key Auth (opt-in) ──
// The dashboard itself is served on localhost and does not require a key.
// Set REQUIRE_AUTH=1 AND API_KEY in .env to protect the /api routes for
// external API consumers. When disabled the key stays in .env for later use.
const API_KEY = process.env.API_KEY;
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === '1' || process.env.REQUIRE_AUTH === 'true';
if (REQUIRE_AUTH && !API_KEY) logger.warn('Security', 'REQUIRE_AUTH=1 but no API_KEY set — set API_KEY in .env.');

function requireAuth(req, res, next) {
  if (!REQUIRE_AUTH) return next();
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized — set x-api-key header' });
  next();
}

// ── CSRF Protection (same-origin check for POST) ──
app.use((req, res, next) => {
  if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) {
    const origin = req.headers.origin || '';
    if (origin) {
      let host;
      try { host = new URL(origin).hostname; } catch { host = ''; }
      const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
      const ip4 = ipv4.exec(host);
      const validIpv4 = ip4 && ip4.slice(1).every(o => Number(o) <= 255);
      const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
      const allowed = host === '' || origin.startsWith('file://') || loopback || !!validIpv4;
      if (!allowed) return res.status(403).json({ error: 'CSRF rejected' });
    }
  }
  next();
});

// Apply auth to all /api routes (except status, events, and config for dashboard bootstrap)
app.use('/api', (req, res, next) => {
  if (req.path === '/status' || req.path === '/events' || req.path === '/config') return next();
  return requireAuth(req, res, next);
});

// Catch GET on POST-only API routes (browser extensions / preflight noise)
app.get('/api/enhance', (_req, res) => res.status(405).json({ error: 'Use POST' }));
app.get('/api/broadcast', (_req, res) => res.status(405).json({ error: 'Use POST' }));
app.get('/api/send', (_req, res) => res.status(405).json({ error: 'Use POST' }));
app.get('/api/send-draft', (_req, res) => res.status(405).json({ error: 'Use POST' }));
app.get('/api/contacts/import', (_req, res) => res.status(405).json({ error: 'Use POST' }));
app.get('/api/contacts/sync', (_req, res) => res.status(405).json({ error: 'Use POST' }));
app.get('/api/access/remove', (_req, res) => res.status(405).json({ error: 'Use POST' }));
app.get('/api/access/clear', (_req, res) => res.status(405).json({ error: 'Use POST' }));

const httpServer = app.listen(PORT, () => {
  logger.info('Dashboard', `Server running at http://localhost:${PORT}`);
});

// ── SSE endpoint ──

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Helpers ──

const axiosInstance = axios.create({ timeout: Number(AXIOS_TIMEOUT_MS) });
logger.info('Config', `OLLAMA_URL=${OLLAMA_URL} MODEL_NAME=${MODEL_NAME} TIMEOUT=${AXIOS_TIMEOUT_MS}ms`);
const userRateLimit = new Map();

function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/(ignore|disregard|override)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi, '')
    .trim()
    .slice(0, MAX_MSG_LEN);
}

function parseVCard(vcfContent) {
  const seen = new Set();
  const contacts = [];
  const cards = vcfContent.split('BEGIN:VCARD');
  for (const card of cards) {
    if (!card.trim()) continue;
    const lines = card.split(/\r?\n/);
    let name = '';
    let encoding = '';
    const phones = [];
    for (const line of lines) {
      const upper = line.toUpperCase();
      // Track encoding
      if (upper.includes('ENCODING=QUOTED-PRINTABLE')) encoding = 'QP';
      // Skip photo lines entirely
      if (upper.startsWith('PHOTO;') || upper.startsWith('PHOTO:')) continue;
      // Parse FN (formatted name) — handle QUOTED-PRINTABLE
      if (upper.startsWith('FN:') || upper.startsWith('FN;')) {
        const raw = line.slice(line.indexOf(':') + 1).trim();
        if (encoding === 'QP' && line.toUpperCase().includes('QUOTED-PRINTABLE')) {
          try {
            name = raw.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          } catch { name = raw; }
        } else {
          name = raw;
        }
      }
      // Parse TEL — accept CELL, HOME, WORK, PREF, VOICE, MSG, FAX, etc.
      if (upper.startsWith('TEL') && !upper.startsWith('TEL;TYPE=')) {
        const phone = line.slice(line.indexOf(':') + 1).replace(/[^0-9+]/g, '').replace(/^\+/, '');
        if (phone && phone.length >= 7 && !phones.includes(phone)) phones.push(phone);
      }
    }
    if (phones.length === 0) continue;
    const cleanName = name.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/[;,]/g, '').trim();
    // Filter: skip empty names or single-character names
    const displayName = cleanName || 'Unknown';
    for (const phone of phones) {
      if (seen.has(phone)) continue;
      seen.add(phone);
      contacts.push({ phone, name: displayName });
    }
  }
  return contacts;
}

function splitMessage(text) {
  if (text.length <= MAX_WHATSAPP_LEN) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_WHATSAPP_LEN) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('. ', MAX_WHATSAPP_LEN);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', MAX_WHATSAPP_LEN);
    if (splitAt <= 0) splitAt = MAX_WHATSAPP_LEN; else splitAt += 1;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

function detectSwahili(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return swahiliHints.some((w) => lower.includes(w));
}

// Cascade-delete a contact and all related data (clean removal).
function deleteContactCascade(chatId) {
  const t = db.transaction((id) => {
    stmts.deleteMessagesByChat.run(id);
    db.prepare(`DELETE FROM evaluations WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM drafts WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM feedback WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM registrations WHERE chat_id = ?`).run(id);
    db.prepare(`DELETE FROM conversations WHERE chat_id = ?`).run(id);
    return stmts.dropContact.run(id);
  });
  return t(chatId);
}

// Reconcile local contacts against the live WhatsApp contact book:
//  - matched numbers  -> on_whatsapp=1, wa_name set, name = WhatsApp name (WhatsApp wins)
//  - unmatched numbers -> on_whatsapp=0 (drop candidates)
//  - dropOnly=true     -> permanently delete unmatched contacts (cascade)
async function reconcileContacts({ dropOnly = false } = {}) {
  const waMap = new Map();
  try {
    const wa = await client.getContacts();
    for (const c of wa) {
      if (c.isWAContact) {
        waMap.set(c.id._serialized, (c.pushname || c.name || c.id.user || '').trim());
      }
    }
  } catch (e) {
    logger.error('WhatsApp', `getContacts failed during reconcile: ${e.message}`);
    return { error: e.message };
  }

  const local = stmts.getAllContacts.all();
  let renamed = 0, onWa = 0, offWa = 0, dropped = 0;
  for (const c of local) {
    const waName = waMap.get(c.phone_number);
    if (waName !== undefined) {
      onWa++;
      stmts.setOnWhatsapp.run(1, c.phone_number);
      if (waName) {
        if (waName !== c.wa_name) renamed++;
        // WhatsApp name wins (per host).
        stmts.setWaName.run(waName, waName, waName, c.phone_number);
      }
    } else {
      offWa++;
      stmts.setOnWhatsapp.run(0, c.phone_number);
      if (dropOnly) {
        try { deleteContactCascade(c.phone_number); dropped++; }
        catch (e) { logger.warn('WhatsApp', `Drop failed for ${c.phone_number}: ${e.message}`); }
      }
    }
  }
  return { onWa, offWa, renamed, dropped, total: local.length };
}

function checkRateLimit(userId) {
  const now = Date.now();
  const last = userRateLimit.get(userId) || 0;
  if (now - last < Number(RATE_LIMIT_COOLDOWN_MS)) return false;
  userRateLimit.set(userId, now);
  return true;
}

// Cleanup stale rate limit entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [key, val] of userRateLimit) {
    if (val < cutoff) userRateLimit.delete(key);
  }
}, 600000);

async function callOllama(messages, retries = 2) {
  const payload = { model: MODEL_NAME, messages, stream: false };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      logger.debug('Ollama', `Attempt ${attempt + 1}/${retries + 1} — msgs=${messages.length}`);
      const res = await axiosInstance.post(OLLAMA_URL, payload);
      const content = res.data?.message?.content || '';
      logger.debug('Ollama', `Response OK — length=${content.length} chars`);
      return content || 'No response from AI.';
    } catch (err) {
      logger.error('Ollama', `Attempt ${attempt + 1} FAILED`, { message: err.message, code: err.code, status: err.response?.status });
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error('Ollama unreachable after retries');
}

async function evaluateConversation(chatId) {
  const messages = stmts.getMessages.all(chatId);
  if (messages.length < 3) return;
  const transcript = messages.map((m) => `${m.sender}: ${m.text}`).join('\n');
  try {
    const raw = await callOllama([{ role: 'user', content: `You are an evaluator. Analyze this conversation and return ONLY valid JSON with keys: resolution_score (1-10), sentiment (positive/negative/neutral), needs_human_help (true/false), summary (string). Conversation:\n${transcript}` }]);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      stmts.upsertEvaluation.run(chatId, Math.min(10, Math.max(1, Number(data.resolution_score) || 5)), data.sentiment || 'neutral', data.needs_human_help ? 1 : 0, data.summary || '');
      broadcast('eval', { chatId });
    }
  } catch (err) {
    logger.error('Evaluator', `Failed for ${chatId}`, { error: err.message });
  }
}

async function extractTasks(chatId) {
  const messages = stmts.getMessages.all(chatId);
  if (messages.length < 3) return;
  const transcript = messages.map((m) => `${m.sender}: ${m.text}`).join('\n');
  try {
    const raw = await callOllama([{ role: 'user', content: `Analyze this conversation. Extract actionable tasks as a JSON array. Each item: { "task_description": "...", "urgency": "HIGH|MEDIUM|LOW" }. Return ONLY the JSON array. No tasks = []. Conversation:\n${transcript}` }]);
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      const tasks = JSON.parse(arrMatch[0]);
      for (const t of tasks) {
        if (t.task_description) {
          stmts.insertTask.run(chatId, t.task_description, t.urgency || 'MEDIUM');
        }
      }
      if (tasks.length) broadcast('task', { chatId });
    }
  } catch (err) {
    logger.error('TaskExtractor', `Failed for ${chatId}`, { error: err.message });
  }
}

// ── WhatsApp Client ──

let whatsappReady = false;
let qrCode = null;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: PUPPETEER_HEADLESS === 'true',
    args: PUPPETEER_ARGS.split(',').map((a) => a.trim()),
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  },
});

client.on('qr', (qr) => {
  qrCode = qr;
  whatsappReady = false;
  logger.info('WhatsApp', 'QR code received — scan with your phone');
  qrcode.generate(qr, { small: true });
  broadcast('status', { connected: false, qr: true });
});

client.on('authenticated', () => logger.info('WhatsApp', 'Authenticated'));

client.on('auth_failure', (msg) => {
  logger.error('WhatsApp', `Auth failure: ${msg}`);
  broadcast('status', { connected: false, error: msg });
});

client.on('ready', async () => {
  whatsappReady = true;
  qrCode = null;
  logger.info('WhatsApp', 'Kamila bot connected');
  try {
    const res = await reconcileContacts({ dropOnly: false });
    logger.info('WhatsApp', `Reconciled contacts: ${res.onWa} on WhatsApp, ${res.offWa} not on WhatsApp (${res.renamed} renamed)`);
    broadcast('contact', { synced: res.onWa, offWa: res.offWa });
  } catch (e) {
    logger.error('WhatsApp', `Contact sync failed: ${e.message}`);
  }
  broadcast('status', { connected: true });
});

client.on('loading_screen', (percent, message) => logger.debug('WhatsApp', `Loading: ${percent}% - ${message}`));

client.on('disconnected', (reason) => {
  whatsappReady = false;
  logger.error('WhatsApp', `Disconnected: ${reason}`);
  broadcast('status', { connected: false, reason });
  logger.info('WhatsApp', 'Reconnecting in 5s...');
  setTimeout(() => client.initialize(), 5000);
});

client.on('change_state', (state) => logger.debug('WhatsApp', `State: ${state}`));

client.on('message', async (msg) => {
  try {
    if (!whatsappReady) return;
    if (msg.from === 'status@broadcast') return;
    const isGroup = msg.from.endsWith('@g.us');
    const chatId = msg.from;
    const body = sanitizeInput(msg.body);
    if (!body) return;

    // Log all messages (including groups) for context.
    // New incoming numbers are auto-registered as AUTO (per host: any new chat = AUTO until toggled).
    stmts.upsertContactFromChat.run(msg.from, msg._data?.pushname || msg._data?.notifyName || msg.from);
    const contact = stmts.getContact.get(msg.from);
    const mode = contact?.auto_reply_mode || 'AUTO';

    stmts.insertMessage.run(chatId, msg.from, body, 0);
    broadcast('message', { chatId });

    // Groups: read-only, no reply, no AI
    if (isGroup) return;

    // Registration prompt: non-blocking. Marks a PENDING registration for the dashboard.
    // The chat still gets normal AUTO replies (registration never blocks conversation).
    try {
      if (contact && contact.registered === 0 && !isGroup) {
        const lastReg = stmts.getRegistration.get(chatId);
        if (!lastReg || lastReg.status !== 'PENDING') {
          const prompt = detectSwahili(body)
            ? 'Habari! Mimi ni Kamila, msaidizi wa Francis. Tafadhali niambie jina lako ili nikusajili.'
            : "Hi! I'm Kamila, Francis's assistant. Please tell me your name so I can register you.";
          stmts.insertMessage.run(chatId, 'kamila', prompt, 1);
          broadcast('message', { chatId });
          await msg.reply(prompt);
          stmts.insertRegistration.run(chatId, contact.name || '');
          logger.info('Bot', `Registration prompt sent to ${chatId}`);
        } else if (/^[a-zA-Z\u00C0-\u024F][a-zA-Z\u00C0-\u024F .'-]{1,40}$/.test(body.trim())) {
          // User replied with what looks like a name (pending) — record it as the submitted name.
          stmts.insertRegistration.run(chatId, body.trim());
        }
        // fall through: still run normal AUTO conversation (non-blocking)
      }
    } catch (regErr) {
      logger.warn('Bot', `Registration flow error for ${chatId}: ${regErr.message}`);
    }

    if (!checkRateLimit(msg.from)) return;
    if (mode === 'OFF') return;

    // Stop-until-resolved gate: if this chat is flagged needs-human-help, do NOT run AI.
    // Stay paused (silent after the first handoff) until Francis resolves the flag.
    const evalRow = stmts.getEvaluation.get(chatId);
    if (evalRow?.needs_human_help === 1) {
      const lastSent = pausedHandoffSent.get(chatId) || 0;
      if (Date.now() - lastSent >= HANDOFF_RESEND_MS) {
        const handoff = detectSwahili(body) ? HANDOFF_SW : HANDOFF_EN;
        pausedHandoffSent.set(chatId, Date.now());
        stmts.insertMessage.run(chatId, 'kamila', handoff, 1);
        broadcast('message', { chatId });
        try { await msg.reply(handoff); } catch (e) { logger.warn('Bot', `Handoff send failed: ${e.message}`); }
      }
      logger.info('Bot', `Chat ${chatId} is flagged needs-human-help — AI paused`);
      return;
    }

    try {
      const chat = await msg.getChat();
      await chat.sendStateTyping();
    } catch (typingErr) {
      logger.warn('Bot', `Typing indicator failed: ${typingErr.message}`);
    }

    const history = stmts.getMessages.all(chatId).reverse().slice(-10);
    // Persona comes from the model's built-in SYSTEM (Modelfile), not injected here.
    const ollamaMessages = history.map((m) => ({ role: m.is_ai ? 'assistant' : 'user', content: m.text }));

    // Inject memory context if available
    const memoryCtx = buildMemoryContext(chatId, memStmts);
    if (memoryCtx) ollamaMessages.unshift(memoryCtx);

    const aiReplyRaw = await callOllama(ollamaMessages);
    // Format for WhatsApp: convert markdown to WhatsApp-native formatting, hard-cap to 10 words
    const aiReply = enforceWordCap(formatForWhatsApp(aiReplyRaw));

    if (mode === 'DRAFT') {
      const draftRow = stmts.insertDraft.run(chatId, msg.from, aiReply);
      broadcast('draft', { chatId, id: draftRow.lastInsertRowid });
      await msg.reply(`📝 *Draft saved*\nPreview: ${aiReply.slice(0, 150)}...`);
      return;
    }

    // Human-like typing delay: ~40ms per char, min 1.5s, max 8s
    const charCount = aiReply.length;
    const typingDelay = Math.min(8000, Math.max(1500, charCount * 40));
    await new Promise((r) => setTimeout(r, typingDelay));

    stmts.insertMessage.run(chatId, 'kamila', aiReply, 1);
    broadcast('message', { chatId });
    const chunks = splitMessage(aiReply);
    for (const chunk of chunks) await msg.reply(chunk);

    setTimeout(() => { evaluateConversation(chatId); extractTasks(chatId); maybeUpdateMemory(chatId, memStmts, callOllama, db); }, 5000);
  } catch (err) {
    logger.error('Bot', `Error handling message from ${chatId}`, { message: err.message, code: err.code, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
    try { await msg.reply('⚠️ *Kamila Error*: AI server unreachable. Is Ollama running?'); } catch {}
  }
});

// ── API Routes ──

app.get('/api/status', (_req, res) => {
  res.json({ connected: whatsappReady, hasQr: !!qrCode, hasApiKey: REQUIRE_AUTH });
});

app.get('/api/config', (_req, res) => {
  res.json({
    ollamaUrl: OLLAMA_URL,
    modelName: MODEL_NAME,
    timeout: AXIOS_TIMEOUT_MS,
    rateLimit: RATE_LIMIT_COOLDOWN_MS,
    hasApiKey: false,
  });
});

app.get('/api/stats', (_req, res) => {
  try {
    const contacts = stmts.countTable('contacts');
    const messages = stmts.countTable('messages');
    const aiMessages = stmts.countAiMessages();
    const openTasks = stmts.countOpenTasks();
    const needsHelp = stmts.getChatsNeedingHelp.all().length;
    const avgRow = stmts.avgScore.get();
    const satisfaction = { avgScore: avgRow?.avg ? Math.round(avgRow.avg * 10) / 10 : null, byChat: stmts.getAllEvaluations.all().map((e) => ({ chat_id: e.chat_id, score: e.resolution_score })) };
    const sentimentMix = {};
    for (const row of stmts.sentimentMix.all()) sentimentMix[row.sentiment || 'unknown'] = row.n;
    const modeMix = {};
    for (const row of stmts.modeMix.all()) modeMix[row.mode || 'AUTO'] = row.n;
    const volume = stmts.volumeTrend.all().reverse();
    const taskDone = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'DONE'`).get().n;
    res.json({
      totals: { contacts, messages, aiMessages, openTasks, needsHelp },
      satisfaction, sentimentMix, modeMix, volume,
      taskCompletion: { done: taskDone, pending: openTasks },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contacts', (_req, res) => res.json(stmts.getChattedContacts.all()));

app.get('/api/contacts/:id/messages', (req, res) => res.json(stmts.getContactMessages.all(req.params.id)));

app.get('/api/messages', (_req, res) => res.json(stmts.getAllMessages.all()));

app.get('/api/tasks', (req, res) => {
  const all = req.query.all === '1';
  res.json(all ? stmts.getAllTasks.all() : stmts.getTasks.all());
});

app.get('/api/alerts', (_req, res) => res.json(stmts.getChatsNeedingHelp.all()));

app.get('/api/evaluations', (_req, res) => res.json(stmts.getAllEvaluations.all()));

app.get('/api/evaluations/:chatId', (req, res) => res.json(stmts.getEvaluation.get(req.params.chatId) || {}));

app.get('/api/drafts', (_req, res) => res.json(stmts.getDrafts.all()));

app.get('/api/drafts/:chatId', (req, res) => res.json(stmts.getDraftsByChat.all(req.params.chatId)));

app.post('/api/contacts/:id/mode', (req, res) => {
  const { mode } = req.body;
  if (!['AUTO', 'DRAFT', 'OFF'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
  const id = req.params.id;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Invalid contact id' });
  // Upsert: create contact if it doesn't exist, then set mode
  stmts.upsertContact.run(id, '');
  stmts.setContactMode.run(mode, id);
  broadcast('contact', { phone_number: id, mode });
  res.json({ ok: true, mode });
});

// ── Access control (whitelist / blacklist) — DISABLED, kept for recovery. ──
// app.get('/api/access', (_req, res) => {
//   res.json({
//     whitelist: stmts.getWhitelist.all().map(r => r.phone_number),
//     blacklist: stmts.getBlacklist.all().map(r => r.phone_number),
//     allowlistActive: stmts.getWhitelistCount.get().n > 0,
//   });
// });
//
// app.get('/api/access/status/:phone', (req, res) => {
//   const phone = canonicalPhone(req.params.phone);
//   if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
//   res.json({ phone, allowed: accessAllowed(phone) });
// });
//
// app.post('/api/access', (req, res) => {
//   const { phone, list_type } = req.body || {};
//   const normalized = canonicalPhone(phone);
//   if (!normalized) return res.status(400).json({ error: 'Invalid phone number' });
//   if (!['WHITELIST', 'BLACKLIST'].includes(list_type))
//     return res.status(400).json({ error: 'list_type must be WHITELIST or BLACKLIST' });
//   stmts.addAccess.run(normalized, list_type);
//   broadcast('access', { phone: normalized, list_type });
//   res.json({ ok: true, phone: normalized, list_type });
// });
//
// app.post('/api/access/remove', (req, res) => {
//   const { phone } = req.body || {};
//   const normalized = canonicalPhone(phone);
//   if (!normalized) return res.status(400).json({ error: 'Invalid phone number' });
//   stmts.removeAccess.run(normalized);
//   broadcast('access', { phone: normalized, removed: true });
//   res.json({ ok: true, phone: normalized });
// });
//
// app.post('/api/access/clear', (req, res) => {
//   const { list_type } = req.body || {};
//   if (!['WHITELIST', 'BLACKLIST'].includes(list_type))
//     return res.status(400).json({ error: 'list_type must be WHITELIST or BLACKLIST' });
//   const info = stmts.clearAccess.run(list_type);
//   broadcast('access', { list_type, cleared: true });
//   res.json({ ok: true, list_type, cleared: info.changes });
// });

app.post('/api/contacts/import', (req, res) => {
  let { contacts, vcard } = req.body;
  if (vcard && typeof vcard === 'string') {
    contacts = parseVCard(vcard);
  }
  if (!Array.isArray(contacts) || contacts.length === 0)
    return res.status(400).json({ error: 'Provide { contacts: [{phone,name}, ...] } or { vcard: "BEGIN:VCARD..." }' });
  if (contacts.length > 10000)
    return res.status(400).json({ error: 'Max 10000 contacts per import' });

  const insertAll = db.transaction((items) => {
    let added = 0, updated = 0, skipped = 0;
    const seenPhones = new Set();
    for (const c of items) {
      const raw = String(c.phone || c.number || '').replace(/[^0-9]/g, '');
      if (!raw || raw.length < 7) { skipped++; continue; }
      // Deduplicate by normalized phone
      if (seenPhones.has(raw)) { skipped++; continue; }
      seenPhones.add(raw);
      const phone = raw + '@c.us';
      const name = String(c.name || '').trim();
      // Skip contacts with garbage names
      if (name && (name === 'Unknown' || name.length < 2 || /^[\d\s+\-().]+$/.test(name))) {
        skipped++; continue;
      }
      const existing = stmts.getContact.get(phone);
      stmts.upsertContactBatch.run({ phone, name });
      if (existing) updated++; else added++;
    }
    return { added, updated, skipped };
  });

  try {
    const result = insertAll(contacts);
    broadcast('contact', { imported: true });
    res.json({ ok: true, added: result.added, updated: result.updated, skipped: result.skipped, total: contacts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/sync', async (req, res) => {
  if (!client.info) return res.status(503).json({ error: 'WhatsApp client not ready' });
  const res2 = await reconcileContacts({ dropOnly: true });
  if (res2.error) return res.status(500).json({ error: res2.error });
  broadcast('contact', { synced: true, matched: res2.onWa, dropped: res2.dropped, renamed: res2.renamed });
  res.json({ ok: true, matched: res2.onWa, dropped: res2.dropped, renamed: res2.renamed, offWa: res2.offWa, total: res2.total });
});

// Registrations (new-number onboarding)
app.get('/api/registrations', (_req, res) => {
  const pending = stmts.getPendingRegistrations.all().map((r) => {
    const contact = stmts.getContact.get(r.chat_id);
    return { ...r, wa_name: contact?.wa_name || contact?.name || '', phone: r.chat_id };
  });
  res.json(pending);
});

app.post('/api/registrations/:chatId/approve', (req, res) => {
  const { chatId } = req.params;
  if (!chatId || typeof chatId !== 'string') return res.status(400).json({ error: 'chatId required' });
  stmts.approveRegistration.run(chatId);
  stmts.registerContact.run(chatId);
  broadcast('contact', { chatId, registered: true });
  res.json({ ok: true });
});

app.post('/api/registrations/:chatId/reject', (req, res) => {
  const { chatId } = req.params;
  if (!chatId || typeof chatId !== 'string') return res.status(400).json({ error: 'chatId required' });
  stmts.rejectRegistration.run(chatId);
  deleteContactCascade(chatId);
  broadcast('contact', { chatId, rejected: true });
  res.json({ ok: true });
});

// Manual drop of a contact (cascade delete) — for dashboard cleanup.
app.post('/api/contacts/drop', (req, res) => {
  const { chatId } = req.body || {};
  if (!chatId || typeof chatId !== 'string') return res.status(400).json({ error: 'chatId required' });
  deleteContactCascade(chatId);
  broadcast('contact', { chatId, dropped: true });
  res.json({ ok: true });
});

app.post('/api/send', async (req, res) => {
  const { chatId, text } = req.body;
  if (!chatId || !text || typeof chatId !== 'string' || typeof text !== 'string')
    return res.status(400).json({ error: 'chatId and text required (strings)' });
  if (!/^\d+@(c\.us|lid|g\.us|s\.whatsapp\.net)$/.test(chatId))
    return res.status(400).json({ error: 'Invalid chatId format (expected number@c.us etc.)' });
  if (text.length > 10000)
    return res.status(400).json({ error: 'Message too long (max 10000 chars)' });
  // Access control disabled — manual send allowed to any number.
  // if (!accessAllowed(chatId))
  //   return res.status(403).json({ error: 'This contact is blocked by access control' });
  try {
    for (const chunk of splitMessage(text)) await client.sendMessage(chatId, chunk);
    stmts.insertMessage.run(chatId, 'kamila', text, 1);
    broadcast('message', { chatId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-draft', async (req, res) => {
  const { draftId, chatId } = req.body;
  if (draftId && typeof draftId !== 'number') return res.status(400).json({ error: 'draftId must be a number' });
  let draft;
  if (draftId) {
    draft = stmts.getDraftById.get(draftId);
  } else if (chatId) {
    draft = stmts.getDraftsByChat.get(chatId);
  }
  if (!draft) return res.status(404).json({ error: 'No draft found' });
  // Access control disabled — draft send allowed to any number.
  // if (!accessAllowed(draft.chat_id))
  //   return res.status(403).json({ error: 'This contact is blocked by access control' });
  try {
    for (const chunk of splitMessage(draft.text)) await client.sendMessage(draft.to_number, chunk);
    stmts.insertMessage.run(draft.chat_id, 'kamila', draft.text, 1);
    stmts.deleteDraft.run(draft.id);
    broadcast('message', { chatId: draft.chat_id });
    broadcast('draft', { chatId: draft.chat_id, deleted: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/discard-draft', (req, res) => {
  const { draftId } = req.body;
  if (!draftId) return res.status(400).json({ error: 'draftId required' });
  const draft = stmts.getDraftById.get(draftId);
  stmts.deleteDraft.run(draftId);
  if (draft) broadcast('draft', { chatId: draft.chat_id, deleted: true });
  res.json({ ok: true });
});

app.post('/api/complete-task', (req, res) => {
  const { taskId } = req.body;
  if (!taskId || typeof taskId !== 'number') return res.status(400).json({ error: 'taskId required (number)' });
  stmts.completeTask.run(taskId);
  broadcast('task', { completed: taskId });
  res.json({ ok: true });
});

app.post('/api/evaluate', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId || typeof chatId !== 'string')
    return res.status(400).json({ error: 'chatId required (string)' });
  await evaluateConversation(chatId);
  await extractTasks(chatId);
  res.json({ ok: true });
});

// Francis clears the flag on a chat — AI resumes normal replies
app.post('/api/evaluate/resolve', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId || typeof chatId !== 'string')
    return res.status(400).json({ error: 'chatId required (string)' });
  stmts.resolveEvaluation.run(chatId);
  pausedHandoffSent.delete(chatId);
  broadcast('eval', { chatId });
  logger.info('Bot', `Chat ${chatId} resolved by Francis — AI resumed`);
  res.json({ ok: true });
});

// ── Broadcast ──

// ── Feedback API ──

app.get('/api/feedback', (_req, res) => res.json(stmts.getAllFeedback.all()));

app.get('/api/feedback/stats', (_req, res) => res.json(stmts.getFeedbackStats.all()));

app.get('/api/feedback/:chatId', (req, res) => res.json(stmts.getFeedbackByChat.all(req.params.chatId)));

app.post('/api/feedback', (req, res) => {
  const { chatId, messageTs, rating, comment } = req.body;
  if (!chatId || typeof chatId !== 'string') return res.status(400).json({ error: 'chatId required' });
  if (![1, -1].includes(rating)) return res.status(400).json({ error: 'rating must be 1 or -1' });
  stmts.insertFeedback.run(chatId, messageTs || null, rating, comment || null);
  broadcast('feedback', { chatId, rating });
  res.json({ ok: true });
});

// ── Memory API ──

app.get('/api/memory', (_req, res) => res.json(getMemoryStats(memStmts)));

// ── Broadcast ──

app.post('/api/broadcast', async (req, res) => {
  const { contacts, text, delayMs } = req.body;
  if (!Array.isArray(contacts) || contacts.length === 0)
    return res.status(400).json({ error: 'contacts array required (phone numbers)' });
  if (!text || typeof text !== 'string')
    return res.status(400).json({ error: 'text required' });
  if (text.length > 10000)
    return res.status(400).json({ error: 'Message too long (max 10000 chars)' });
  if (contacts.length > 500)
    return res.status(400).json({ error: 'Max 500 contacts per broadcast' });

  const delay = Math.max(1000, Math.min(30000, Number(delayMs) || 2000));
  let sent = 0, failed = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < contacts.length; i++) {
    const phone = contacts[i];
    const chatId = phone.includes('@') ? phone : phone.replace(/[^0-9]/g, '') + '@c.us';
    // Access control disabled — broadcast to any number.
    // if (!accessAllowed(chatId)) { skipped++; continue; }
    try {
      for (const chunk of splitMessage(text)) await client.sendMessage(chatId, chunk);
      stmts.insertMessage.run(chatId, 'kamila', text, 1);
      broadcast('message', { chatId });
      sent++;
    } catch (err) {
      failed++;
      errors.push({ phone: chatId, error: err.message });
    }
    if (i < contacts.length - 1) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  broadcast('broadcast', { sent, failed, skipped, total: contacts.length });
  res.json({ ok: true, sent, failed, skipped, total: contacts.length, errors: errors.slice(0, 10) });
});

// ── AI Enhance ──

app.post('/api/enhance', async (req, res) => {
  const { text, mode } = req.body;
  if (!text || typeof text !== 'string')
    return res.status(400).json({ error: 'text required' });
  if (text.length > 2000)
    return res.status(400).json({ error: 'Text too long for enhancement (max 2000 chars)' });

  const enhanceMode = mode || 'professional'; // professional, casual, friendly, formal
  const prompts = {
    professional: 'Rewrite this message to be clear, professional, and well-structured. Keep the core meaning. Return ONLY the rewritten message.',
    casual: 'Rewrite this message in a casual, relaxed tone. Keep the core meaning. Return ONLY the rewritten message.',
    friendly: 'Rewrite this message to be warm and friendly. Keep the core meaning. Return ONLY the rewritten message.',
    formal: 'Rewrite this message in formal business language. Keep the core meaning. Return ONLY the rewritten message.',
    polish: 'Polish this message for clarity and impact. Fix grammar, improve flow. Return ONLY the polished message.',
  };

  try {
    const prompt = prompts[enhanceMode] || prompts.professional;
    const enhanced = await callOllama([
      { role: 'system', content: 'You are a professional writing assistant. Enhance messages while preserving their meaning.' },
      { role: 'user', content: `${prompt}\n\nOriginal message:\n${text}` },
    ]);
    broadcast('enhance', { original: text.slice(0, 100), enhanced: enhanced.slice(0, 100) });
    res.json({ ok: true, original: text, enhanced, mode: enhanceMode });
  } catch (err) {
    res.status(500).json({ error: 'AI enhancement failed: ' + err.message });
  }
});

// ── Graceful Shutdown ──

async function shutdown() {
  logger.info('Shutdown', 'Cleaning up...');
  try { await client.destroy(); } catch {}
  try { db.close(); } catch {}
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.initialize();
