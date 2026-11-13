// The Kamila AI bot: the owner's personal assistant on the "default" WhatsApp
// number. Replies with Gemini using a persona (prompts/kamila.md), keeps
// per-contact memory, extracts tasks, and pauses itself when a chat needs a human.
import logger from '../utils/logger.js';
import { buildMemoryContext, maybeUpdateMemory } from './memory.js';
import { formatForWhatsApp, enforceWordCap } from './format.js';

const MAX_INPUT = 2000;
const MAX_WA_LEN = 4000;
const HANDOFF_EN = "Sorry, I can't help with this one. Francis will get back to you.";
const HANDOFF_SW = 'Samahani, siwezi kusaidia hapa. Francis atakufuatilia.';
const HANDOFF_RESEND_MS = 10 * 60 * 1000;
const SWAHILI_HINTS = ['niambie', 'mambo', 'vipi', 'mzee', 'habari', 'sawa', 'poa', 'pole', 'rafiki', 'kaka', 'dada', 'nini', 'hapana', 'ndio', 'asante', 'karibu', 'kesho', 'leo', 'yaani', 'kweli', 'sasa', 'nimechoka', 'nimekasirika', 'wewe', 'mimi', 'unataka', 'usijali', 'sina', 'hapa', 'tafadhali'];

export function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/(ignore|disregard|override)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi, '')
    .trim()
    .slice(0, MAX_INPUT);
}

export function splitMessage(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > MAX_WA_LEN) {
    let at = rest.lastIndexOf('. ', MAX_WA_LEN);
    if (at <= 0) at = rest.lastIndexOf(' ', MAX_WA_LEN);
    at = at <= 0 ? MAX_WA_LEN : at + 1;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const isSwahili = (text) => SWAHILI_HINTS.some((w) => text.toLowerCase().includes(w));

/**
 * @param {object} o
 * @param {object} o.store      bot SQLite store ({ db, stmts, memStmts, deleteContactCascade })
 * @param {object} o.gemini     Gemini client
 * @param {string} o.persona    system prompt for replies
 * @param {(event:string, data:object)=>void} o.emit  dashboard live updates (owners only)
 * @param {number} [o.cooldownMs] minimum gap between replies to the same contact
 */
export function createKamilaBot({ store, gemini, persona, emit, cooldownMs = 2000 }) {
  const { db, stmts, memStmts } = store;
  const state = { client: null, ready: false, qr: null };
  const lastReply = new Map();   // chatId -> timestamp (cooldown)
  const handoffSent = new Map(); // chatId -> timestamp

  setInterval(() => {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, t] of lastReply) if (t < cutoff) lastReply.delete(k);
  }, 600_000).unref();

  // Gemini call; 'system' messages become the system instruction.
  async function callAI(messages, { withPersona = false, retries = 1 } = {}) {
    const system = [withPersona ? persona : '', ...messages.filter((m) => m.role === 'system').map((m) => m.content)].filter(Boolean).join('\n\n');
    const turns = messages.filter((m) => m.role !== 'system');
    for (let attempt = 0; ; attempt++) {
      try {
        return await gemini.generate({ system: system || undefined, messages: turns, temperature: withPersona ? 0.55 : 0.2 });
      } catch (err) {
        logger.error('AI', `Gemini attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt >= retries || ['ai_not_configured', 'ai_bad_key', 'ai_bad_model'].includes(err.code)) throw err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  const transcript = (chatId) => stmts.getRecentMessages.all(chatId).map((m) => `${m.sender}: ${m.text}`).join('\n');

  async function evaluateConversation(chatId) {
    if (stmts.getRecentMessages.all(chatId).length < 3) return;
    try {
      const raw = await callAI([{ role: 'user', content: `You are an evaluator. Analyze this conversation and return ONLY valid JSON with keys: resolution_score (1-10), sentiment (positive/negative/neutral), needs_human_help (true/false), summary (string). Conversation:\n${transcript(chatId)}` }]);
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return;
      const d = JSON.parse(m[0]);
      stmts.upsertEvaluation.run(chatId, Math.min(10, Math.max(1, Number(d.resolution_score) || 5)), d.sentiment || 'neutral', d.needs_human_help ? 1 : 0, d.summary || '');
      emit('eval', { chatId });
    } catch (err) {
      logger.error('Evaluator', `Failed for ${chatId}: ${err.message}`);
    }
  }

  async function extractTasks(chatId) {
    if (stmts.getRecentMessages.all(chatId).length < 3) return;
    try {
      const raw = await callAI([{ role: 'user', content: `Analyze this conversation. Extract actionable tasks as a JSON array. Each item: { "task_description": "...", "urgency": "HIGH|MEDIUM|LOW" }. Return ONLY the JSON array. No tasks = []. Conversation:\n${transcript(chatId)}` }]);
      const m = raw.match(/\[[\s\S]*\]/);
      if (!m) return;
      const tasks = JSON.parse(m[0]).filter((t) => t?.task_description);
      for (const t of tasks) stmts.insertTask.run(chatId, t.task_description, ['HIGH', 'MEDIUM', 'LOW'].includes(t.urgency) ? t.urgency : 'MEDIUM');
      if (tasks.length) emit('task', { chatId });
    } catch (err) {
      logger.error('Tasks', `Failed for ${chatId}: ${err.message}`);
    }
  }

  // Match local contacts against the WhatsApp address book. WhatsApp names win.
  // dropMissing: permanently delete contacts that are not on WhatsApp.
  async function reconcileContacts({ dropMissing = false } = {}) {
    const wa = new Map();
    for (const c of await state.client.getContacts()) {
      if (c.isWAContact) wa.set(c.id._serialized, (c.pushname || c.name || c.id.user || '').trim());
    }
    let onWa = 0, offWa = 0, renamed = 0, dropped = 0;
    const local = stmts.getAllContacts.all();
    for (const c of local) {
      const waName = wa.get(c.phone_number);
      if (waName !== undefined) {
        onWa++;
        stmts.setOnWhatsapp.run(1, c.phone_number);
        if (waName) {
          if (waName !== c.wa_name) renamed++;
          stmts.setWaName.run(waName, waName, waName, c.phone_number);
        }
      } else {
        offWa++;
        stmts.setOnWhatsapp.run(0, c.phone_number);
        if (dropMissing) { store.deleteContactCascade(c.phone_number); dropped++; }
      }
    }
    return { onWa, offWa, renamed, dropped, total: local.length };
  }

  async function onMessage(msg) {
    const chatId = msg.from;
    try {
      if (!state.ready || chatId === 'status@broadcast') return;
      const body = sanitizeInput(msg.body);
      if (!body) return;
      const isGroup = chatId.endsWith('@g.us');

      // Every message is logged; new numbers start in AUTO mode.
      stmts.upsertContactFromChat.run(chatId, msg._data?.pushname || msg._data?.notifyName || chatId);
      const contact = stmts.getContact.get(chatId);
      stmts.insertMessage.run(chatId, chatId, body, 0);
      emit('message', { chatId });
      if (isGroup) return; // groups are read-only context

      // Unregistered contacts are asked for their name once (non-blocking).
      if (contact && contact.registered === 0) {
        const reg = stmts.getRegistration.get(chatId);
        if (!reg || reg.status !== 'PENDING') {
          const prompt = isSwahili(body)
            ? 'Habari! Mimi ni Kamila, msaidizi wa Francis. Tafadhali niambie jina lako ili nikusajili.'
            : "Hi! I'm Kamila, Francis's assistant. Please tell me your name so I can register you.";
          stmts.insertMessage.run(chatId, 'kamila', prompt, 1);
          emit('message', { chatId });
          await msg.reply(prompt);
          stmts.insertRegistration.run(chatId, contact.name || '');
        } else if (/^[a-zA-ZÀ-ɏ][a-zA-ZÀ-ɏ .'-]{1,40}$/.test(body)) {
          stmts.insertRegistration.run(chatId, body);
        }
      }

      const mode = contact?.auto_reply_mode || 'AUTO';
      if (mode === 'OFF') return;
      if (Date.now() - (lastReply.get(chatId) || 0) < cooldownMs) return;
      lastReply.set(chatId, Date.now());

      // Paused until the owner resolves it: send a hand-off note at most every 10 minutes.
      if (stmts.getEvaluation.get(chatId)?.needs_human_help === 1) {
        if (Date.now() - (handoffSent.get(chatId) || 0) >= HANDOFF_RESEND_MS) {
          const note = isSwahili(body) ? HANDOFF_SW : HANDOFF_EN;
          handoffSent.set(chatId, Date.now());
          stmts.insertMessage.run(chatId, 'kamila', note, 1);
          emit('message', { chatId });
          await msg.reply(note).catch(() => {});
        }
        return;
      }

      try { await (await msg.getChat()).sendStateTyping(); } catch {}
      const history = stmts.getRecentMessages.all(chatId).reverse().slice(-10)
        .map((m) => ({ role: m.is_ai ? 'assistant' : 'user', content: m.text }));
      const memory = buildMemoryContext(chatId, memStmts);
      if (memory) history.unshift(memory);
      const reply = enforceWordCap(formatForWhatsApp(await callAI(history, { withPersona: true })));

      if (mode === 'DRAFT') {
        const row = stmts.insertDraft.run(chatId, chatId, reply);
        emit('draft', { chatId, id: row.lastInsertRowid });
        return;
      }

      // Human-like typing delay: ~40 ms per character, 1.5–8 s.
      await new Promise((r) => setTimeout(r, Math.min(8000, Math.max(1500, reply.length * 40))));
      stmts.insertMessage.run(chatId, 'kamila', reply, 1);
      emit('message', { chatId });
      for (const chunk of splitMessage(reply)) await msg.reply(chunk);

      setTimeout(() => {
        evaluateConversation(chatId);
        extractTasks(chatId);
        maybeUpdateMemory(chatId, memStmts, (m) => callAI(m), db);
      }, 5000);
    } catch (err) {
      // Stay silent to the contact; the error is in the log.
      logger.error('Bot', `Reply to ${chatId} failed: ${err.message}`);
    }
  }

  // Wire up a (re)created WhatsApp client for the default session.
  function attach(client) {
    state.client = client;
    state.ready = false;
    client.on('qr', (qr) => { state.qr = qr; state.ready = false; emit('status', { connected: false, qr: true }); });
    client.on('auth_failure', (m) => emit('status', { connected: false, error: m }));
    client.on('disconnected', (reason) => { state.ready = false; emit('status', { connected: false, reason }); });
    client.on('ready', async () => {
      state.ready = true;
      state.qr = null;
      emit('status', { connected: true });
      try {
        const r = await reconcileContacts();
        logger.info('Bot', `Contacts: ${r.onWa} on WhatsApp, ${r.offWa} not (${r.renamed} renamed)`);
        emit('contact', { synced: r.onWa });
      } catch (err) {
        logger.warn('Bot', `Contact sync failed: ${err.message}`);
      }
    });
    client.on('message', onMessage);
  }

  // Called by the session manager whenever the default session changes state.
  function setStatus(status, qr) {
    state.ready = status === 'WORKING';
    state.qr = qr;
    if (status === 'STOPPED' || status === 'FAILED') emit('status', { connected: false });
  }

  async function send(chatId, text) {
    if (!state.client || !state.ready) {
      const e = new Error('WhatsApp (Kamila number) is not connected');
      e.status = 503;
      throw e;
    }
    for (const chunk of splitMessage(text)) await state.client.sendMessage(chatId, chunk);
  }

  function resolveHandoff(chatId) {
    stmts.resolveEvaluation.run(chatId);
    handoffSent.delete(chatId);
  }

  return { state, attach, setStatus, send, reconcileContacts, resolveHandoff };
}
