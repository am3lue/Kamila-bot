// /api: the Kamila bot dashboard (owners only; auth is applied by server.js).
import express from 'express';
import { parseVCard } from './vcard.js';

const CHAT_ID_RE = /^\d+@(c\.us|lid|g\.us|s\.whatsapp\.net)$/;

export function createBotRouter({ store, bot, emit, config }) {
  const { db, stmts } = store;
  const router = express.Router();
  router.use(express.json({ limit: '2mb' })); // vCard imports can be large

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const needChatId = (v) => typeof v === 'string' && v.length > 0 && v.length < 100;

  // ── Status & stats ──
  router.get('/status', (_req, res) => res.json({ connected: bot.state.ready, hasQr: !!bot.state.qr }));
  router.get('/config', (_req, res) => res.json(config));

  router.get('/stats', (_req, res) => {
    const s = stmts.stats;
    const openTasks = s.openTasks.get().n;
    const avg = s.avgScore.get()?.avg;
    res.json({
      totals: { contacts: s.contacts.get().n, messages: s.messages.get().n, aiMessages: s.aiMessages.get().n, openTasks, needsHelp: s.needsHelp.get().n },
      satisfaction: { avgScore: avg ? Math.round(avg * 10) / 10 : null },
      sentimentMix: Object.fromEntries(s.sentiment.all().map((r) => [r.sentiment || 'unknown', r.n])),
      modeMix: Object.fromEntries(s.modes.all().map((r) => [r.mode || 'AUTO', r.n])),
      volume: s.volume.all().reverse(),
      taskCompletion: { done: s.doneTasks.get().n, pending: openTasks },
    });
  });

  // ── Contacts & chats ──
  router.get('/contacts', (_req, res) => res.json(stmts.getChattedContacts.all()));
  router.get('/contacts/:id/messages', (req, res) => res.json(stmts.getContactMessages.all(req.params.id)));

  router.post('/contacts/:id/mode', (req, res) => {
    const { mode } = req.body || {};
    if (!['AUTO', 'DRAFT', 'OFF'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
    stmts.upsertContact.run(req.params.id, '');
    stmts.setContactMode.run(mode, req.params.id);
    emit('contact', { phone_number: req.params.id, mode });
    res.json({ ok: true, mode });
  });

  router.post('/contacts/import', (req, res) => {
    let { contacts, vcard } = req.body || {};
    if (typeof vcard === 'string') contacts = parseVCard(vcard);
    if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'Provide { contacts: [{phone,name}] } or { vcard: "BEGIN:VCARD..." }' });
    if (contacts.length > 10000) return res.status(400).json({ error: 'Max 10000 contacts per import' });
    const result = db.transaction((items) => {
      let added = 0, updated = 0, skipped = 0;
      const seen = new Set();
      for (const c of items) {
        const digits = String(c.phone || c.number || '').replace(/[^0-9]/g, '');
        const name = String(c.name || '').trim();
        if (digits.length < 7 || seen.has(digits) || (name && (name === 'Unknown' || name.length < 2 || /^[\d\s+\-().]+$/.test(name)))) { skipped++; continue; }
        seen.add(digits);
        const phone = `${digits}@c.us`;
        const existed = !!stmts.getContact.get(phone);
        stmts.upsertContactBatch.run({ phone, name });
        if (existed) updated++; else added++;
      }
      return { added, updated, skipped };
    })(contacts);
    emit('contact', { imported: true });
    res.json({ ok: true, ...result, total: contacts.length });
  });

  router.post('/contacts/sync', wrap(async (_req, res) => {
    if (!bot.state.ready) return res.status(503).json({ error: 'WhatsApp is not connected' });
    const r = await bot.reconcileContacts({ dropMissing: true });
    emit('contact', { synced: true });
    res.json({ ok: true, matched: r.onWa, dropped: r.dropped, renamed: r.renamed, offWa: r.offWa, total: r.total });
  }));

  router.post('/contacts/drop', (req, res) => {
    const { chatId } = req.body || {};
    if (!needChatId(chatId)) return res.status(400).json({ error: 'chatId required' });
    store.deleteContactCascade(chatId);
    emit('contact', { chatId, dropped: true });
    res.json({ ok: true });
  });

  router.post('/send', wrap(async (req, res) => {
    const { chatId, text } = req.body || {};
    if (!CHAT_ID_RE.test(chatId || '')) return res.status(400).json({ error: 'Invalid chatId (expected number@c.us)' });
    if (typeof text !== 'string' || !text.trim() || text.length > 10000) return res.status(400).json({ error: 'text required (max 10000 chars)' });
    await bot.send(chatId, text);
    stmts.insertMessage.run(chatId, 'kamila', text, 1);
    emit('message', { chatId });
    res.json({ ok: true });
  }));

  // ── Drafts ──
  router.get('/drafts/:chatId', (req, res) => res.json(stmts.getDraftsByChat.all(req.params.chatId)));

  router.post('/send-draft', wrap(async (req, res) => {
    const { draftId, chatId } = req.body || {};
    const draft = typeof draftId === 'number' ? stmts.getDraftById.get(draftId) : needChatId(chatId) ? stmts.getDraftsByChat.get(chatId) : null;
    if (!draft) return res.status(404).json({ error: 'No draft found' });
    await bot.send(draft.to_number, draft.text);
    stmts.insertMessage.run(draft.chat_id, 'kamila', draft.text, 1);
    stmts.deleteDraft.run(draft.id);
    emit('message', { chatId: draft.chat_id });
    emit('draft', { chatId: draft.chat_id, deleted: true });
    res.json({ ok: true });
  }));

  router.post('/discard-draft', (req, res) => {
    const { draftId } = req.body || {};
    if (typeof draftId !== 'number') return res.status(400).json({ error: 'draftId required' });
    const draft = stmts.getDraftById.get(draftId);
    stmts.deleteDraft.run(draftId);
    if (draft) emit('draft', { chatId: draft.chat_id, deleted: true });
    res.json({ ok: true });
  });

  // ── Tasks, evaluations, feedback ──
  router.get('/tasks', (req, res) => res.json(req.query.all === '1' ? stmts.getAllTasks.all() : stmts.getOpenTasks.all()));

  router.post('/complete-task', (req, res) => {
    const { taskId } = req.body || {};
    if (typeof taskId !== 'number') return res.status(400).json({ error: 'taskId required (number)' });
    stmts.completeTask.run(taskId);
    emit('task', { completed: taskId });
    res.json({ ok: true });
  });

  router.get('/evaluations', (_req, res) => res.json(stmts.getAllEvaluations.all()));

  // The owner takes over a flagged chat; the bot resumes replying.
  router.post('/evaluate/resolve', (req, res) => {
    const { chatId } = req.body || {};
    if (!needChatId(chatId)) return res.status(400).json({ error: 'chatId required' });
    bot.resolveHandoff(chatId);
    emit('eval', { chatId });
    res.json({ ok: true });
  });

  router.get('/feedback/stats', (_req, res) => res.json(stmts.getFeedbackStats.all()));

  router.post('/feedback', (req, res) => {
    const { chatId, messageTs, rating, comment } = req.body || {};
    if (!needChatId(chatId)) return res.status(400).json({ error: 'chatId required' });
    if (![1, -1].includes(rating)) return res.status(400).json({ error: 'rating must be 1 or -1' });
    stmts.insertFeedback.run(chatId, messageTs || null, rating, typeof comment === 'string' ? comment.slice(0, 1000) : null);
    res.json({ ok: true });
  });

  // ── Registrations (new numbers asked for their name) ──
  router.get('/registrations', (_req, res) => {
    res.json(stmts.getPendingRegistrations.all().map((r) => {
      const c = stmts.getContact.get(r.chat_id);
      return { ...r, wa_name: c?.wa_name || c?.name || '', phone: r.chat_id };
    }));
  });

  router.post('/registrations/:chatId/approve', (req, res) => {
    stmts.approveRegistration.run(req.params.chatId);
    stmts.registerContact.run(req.params.chatId);
    emit('contact', { chatId: req.params.chatId, registered: true });
    res.json({ ok: true });
  });

  router.post('/registrations/:chatId/reject', (req, res) => {
    stmts.rejectRegistration.run(req.params.chatId);
    store.deleteContactCascade(req.params.chatId);
    emit('contact', { chatId: req.params.chatId, rejected: true });
    res.json({ ok: true });
  });

  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' });
  });

  return router;
}
