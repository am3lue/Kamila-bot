// REST API for the OTP gateway, mounted at /v1.
//
// Credentials, sent as `Authorization: Bearer <token>`:
//   - Tausi session token (dashboard sign-in): manages the caller's own sessions.
//     It can also call the OTP endpoints for a session it owns via `X-Session-Id`.
//   - Session API key (wsk_...): scoped to exactly one WhatsApp session: OTP, send message and Chat API.
import express from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import wweb from 'whatsapp-web.js';
import { STATUS } from './sessions.js';
import { checkWebhookUrl } from './webhooks.js';
import {
  hashKey, newApiKey, newSecret, newSessionId, newOtpId, httpError,
  WEBHOOK_EVENTS, DEFAULT_EVENTS, DEFAULT_OTP_TEMPLATE, parseEvents, MODES,
} from './util.js';

const { MessageMedia } = wweb;
const OTP_DEFAULTS = { length: 6, ttlSeconds: 300, maxAttempts: 5, resendCooldownSec: 60, maxPerPhonePerHour: 5 };
const TEMPLATE_RULES = 'otp_template must contain {code}, be at most 500 characters, and may only use {code}, {brand}, {minutes}';

export function createGatewayRouter({
  repo, manager, webhooks, auth, logger, pepper, chatbot, gemini, sealer,
  maxSessions = 10, maxSessionsPerUser = 2, rateLimitPerMin = 30, allowPrivateWebhooks = false,
  chatPerMin = 60, widgetPerDay = 1000, sendPerRecipientPerMin = 5, failedOtpTtlMin = 10,
  otp: otpOpts = {},
}) {
  const router = express.Router();
  router.use(express.json({ limit: '512kb' })); // knowledge bases can be large
  const otp = { ...OTP_DEFAULTS, ...otpOpts };
  const hashCode = (id, code) => crypto.createHmac('sha256', pepper).update(`${id}:${code}`).digest('hex');
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Every 30s: fail codes that never left, expire stale ones, and delete
  // failed codes 10 minutes after they failed. Week-old rows are purged hourly.
  const emitOtp = (r, status) => manager.emit('otp', { id: r.id, session: r.session_id, ownerId: manager.rt(r.session_id).ownerId ?? null, status });
  setInterval(async () => {
    try {
      for (const r of await repo.failUnsentOtps()) {
        emitOtp(r, 'FAILED');
        webhooks.dispatch(r.session_id, 'otp.status', { id: r.id, phone: r.phone, status: 'FAILED' });
      }
      for (const r of await repo.expireOtps()) emitOtp(r, 'EXPIRED');
      for (const r of await repo.deleteFailedOtps(failedOtpTtlMin)) emitOtp(r, 'DELETED');
    } catch (e) { logger.warn('Gateway', `OTP sweep failed: ${e.message}`); }
  }, 30_000).unref();
  setInterval(() => repo.purgeOld().catch((e) => logger.warn('Gateway', `Purge failed: ${e.message}`)), 3_600_000).unref();

  // ── Auth ──
  const canManage = (req, row) => !!row && (row.owner_id === req.user.id || (row.owner_id === null && req.isOwner));

  const requireUser = wrap(async (req, res, next) => {
    const token = auth.bearer(req);
    if (token.startsWith('wsk_')) throw httpError(403, 'Project API keys can only call the OTP, message and chat endpoints. Sign in to manage projects.');
    const a = await auth.verify(token);
    if (!a) throw httpError(401, 'Sign in required', 'unauthenticated');
    req.user = a.user;
    req.isOwner = auth.isOwner(a.user);
    next();
  });

  const requireSession = wrap(async (req, res, next) => {
    const token = auth.bearer(req);
    if (!token) throw httpError(401, 'API key required (Authorization: Bearer wsk_...)', 'unauthenticated');
    if (token.startsWith('wsk_')) {
      const row = await repo.getSessionByKeyHash(hashKey(token));
      if (!row) throw httpError(401, 'Invalid API key', 'unauthenticated');
      req.session = row;
      return next();
    }
    const a = await auth.verify(token);
    if (!a) throw httpError(401, 'Invalid API key or sign-in token', 'unauthenticated');
    req.user = a.user;
    req.isOwner = auth.isOwner(a.user);
    const id = req.headers['x-session-id'];
    const row = id ? await repo.getSession(String(id)) : null;
    if (!canManage(req, row)) throw httpError(404, 'Session not found (send X-Session-Id for a session you own)');
    req.session = row;
    next();
  });

  // Loads :id and checks ownership (404 rather than 403 so ids can't be probed).
  const ownedSession = wrap(async (req, res, next) => {
    const row = await repo.getSession(req.params.id);
    if (!canManage(req, row)) throw httpError(404, 'Session not found');
    req.session = row;
    next();
  });

  // ── Per-session send rate limit (sliding 60s window) ──
  const sendLog = new Map();
  function rateLimit(req, res, next) {
    const now = Date.now();
    const arr = (sendLog.get(req.session.id) || []).filter((t) => now - t < 60_000);
    if (arr.length >= rateLimitPerMin) {
      res.setHeader('Retry-After', Math.ceil((60_000 - (now - arr[0])) / 1000));
      return res.status(429).json({ error: `Rate limit: max ${rateLimitPerMin} messages per minute per project`, code: 'rate_limited' });
    }
    arr.push(now);
    sendLog.set(req.session.id, arr);
    next();
  }

  // ── Presentation ──
  function describe(row, counts, { includeSecret = true } = {}) {
    const st = manager.state(row.id);
    const c = { sent: 0, verified: 0, received: 0, replied: 0, ...(counts?.get(row.id) || {}) };
    return {
      id: row.id,
      name: row.name,
      mode: row.ai_bot ? 'kamila' : row.mode || 'otp',
      ...st,
      phone: row.phone,
      pushName: row.push_name,
      aiBot: row.ai_bot,
      system: row.owner_id === null,
      autoStart: row.auto_start,
      apiKeyPrefix: row.api_key_prefix,
      otpTemplate: row.otp_template || DEFAULT_OTP_TEMPLATE,
      otpTemplateIsDefault: !row.otp_template,
      webhook: { url: row.webhook_url, events: parseEvents(row.webhook_events), ...(includeSecret ? { secret: row.webhook_secret } : {}) },
      chatbot: {
        model: row.gemini_model || gemini.defaultModel,
        hasOwnKey: !!row.gemini_api_key_enc,
        serverKey: gemini.hasServerKey,
        answerUrl: row.answer_url,
        instructionsChars: row.bot_instructions?.length || 0,
        knowledgeChars: row.knowledge_base?.length || 0,
        ready: chatbot.hasBrain(row),
      },
      publishableKey: row.publishable_key || null,
      allowedOrigins: row.allowed_origins || [],
      widget: widgetSettings(row),
      sentToday: c.sent,
      verifiedToday: c.verified,
      receivedToday: c.received,
      repliedToday: c.replied,
      createdAt: row.created_at,
    };
  }
  async function counts(ids) {
    const [otps, chats] = await Promise.all([repo.todayCounts(ids), repo.todayChatCounts(ids)]);
    const out = new Map();
    for (const id of ids) out.set(id, { ...(otps.get(id) || {}), ...(chats.get(id) || {}) });
    return out;
  }
  const describeOne = async (row, opts) => describe(row, await counts([row.id]), opts);

  function readyClient(req, res) {
    const client = manager.getClient(req.session.id);
    if (!client) {
      const { status } = manager.state(req.session.id);
      res.status(409).json({ error: `Session is not connected (status: ${status})`, code: 'session_not_connected', status });
      return null;
    }
    return client;
  }

  // ═══════════════ Account ═══════════════

  router.get('/account', requireUser, wrap(async (req, res) => {
    const used = await repo.countSessions(req.user.id);
    res.json({
      user: { id: req.user.id, email: req.user.email, name: req.user.name, image: req.user.image },
      isOwner: req.isOwner,
      limits: { sessions: req.isOwner ? maxSessions : maxSessionsPerUser, sessionsUsed: used, otpPerMinute: rateLimitPerMin },
    });
  }));

  // ═══════════════ Sessions (signed-in users) ═══════════════

  router.get('/sessions', requireUser, wrap(async (req, res) => {
    const rows = await repo.listSessionsFor(req.user.id, req.isOwner);
    const c = await counts(rows.map((r) => r.id));
    res.json(rows.map((r) => describe(r, c)));
  }));

  router.post('/sessions', requireUser, wrap(async (req, res) => {
    const { name, webhook_url, webhook_events, auto_start = true, otp_template, mode = 'otp' } = req.body || {};
    if (!MODES.includes(mode)) throw httpError(400, `mode must be one of ${MODES.join(', ')}`);
    if (!name || typeof name !== 'string' || !name.trim() || name.length > 60) throw httpError(400, 'name is required (max 60 chars)');
    const url = validateWebhookUrl(webhook_url, allowPrivateWebhooks);
    const events = validateEvents(webhook_events);
    const tpl = validateTemplate(otp_template);

    if (!req.isOwner && await repo.countSessions(req.user.id) >= maxSessionsPerUser) {
      throw httpError(403, `Your account allows ${maxSessionsPerUser} session(s)`, 'session_limit');
    }
    if (await repo.countSessions() >= maxSessions) throw httpError(503, 'This server has no free session slots right now', 'server_full');

    const apiKey = newApiKey();
    const row = await repo.insertSession({
      id: newSessionId(),
      owner_id: req.user.id,
      name: name.trim(),
      api_key_hash: hashKey(apiKey),
      api_key_prefix: apiKey.slice(0, 12),
      webhook_url: url,
      webhook_secret: newSecret(),
      webhook_events: events,
      otp_template: tpl,
      auto_start: !!auto_start,
      mode,
    });
    if (row.auto_start) await manager.start(row.id);
    logger.info('Gateway', `Session ${row.id} created by ${req.user.id}`);
    res.status(201).json({ ...describe(row, new Map()), apiKey });
  }));

  router.get('/sessions/:id', requireUser, ownedSession, wrap(async (req, res) => res.json(await describeOne(req.session))));

  router.patch('/sessions/:id', requireUser, ownedSession, wrap(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 60) throw httpError(400, 'Invalid name');
      patch.name = b.name.trim();
    }
    if (b.webhook_url !== undefined) patch.webhook_url = validateWebhookUrl(b.webhook_url, allowPrivateWebhooks);
    if (b.webhook_events !== undefined) patch.webhook_events = validateEvents(b.webhook_events);
    if (b.auto_start !== undefined) patch.auto_start = !!b.auto_start;
    if (b.otp_template !== undefined) patch.otp_template = validateTemplate(b.otp_template); // null → default
    if (b.mode !== undefined) {
      if (req.session.ai_bot) throw httpError(400, 'The Kamila session always runs the Kamila AI bot');
      if (!MODES.includes(b.mode)) throw httpError(400, `mode must be one of ${MODES.join(', ')}`);
      patch.mode = b.mode;
    }
    if (b.allowed_origins !== undefined) patch.allowed_origins = validateOrigins(b.allowed_origins);
    if (b.widget !== undefined) patch.widget_settings = validateWidget(b.widget);
    if (b.bot_instructions !== undefined) patch.bot_instructions = optText(b.bot_instructions, 4000, 'bot_instructions');
    if (b.knowledge_base !== undefined) patch.knowledge_base = optText(b.knowledge_base, 200000, 'knowledge_base');
    if (b.answer_url !== undefined) patch.answer_url = validateWebhookUrl(b.answer_url, allowPrivateWebhooks);
    if (b.gemini_model !== undefined) {
      if (b.gemini_model !== null && b.gemini_model !== '' && (typeof b.gemini_model !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(b.gemini_model))) throw httpError(400, 'Invalid gemini_model');
      patch.gemini_model = b.gemini_model || null;
    }
    if (b.gemini_api_key !== undefined) {
      if (b.gemini_api_key !== null && b.gemini_api_key !== '' && (typeof b.gemini_api_key !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(b.gemini_api_key.trim()))) throw httpError(400, 'That does not look like a Gemini API key');
      patch.gemini_api_key_enc = b.gemini_api_key ? sealer.seal(b.gemini_api_key.trim()) : null;
    }
    const row = Object.keys(patch).length ? await repo.updateSession(req.session.id, patch) : req.session;
    res.json(await describeOne(row));
  }));

  router.delete('/sessions/:id', requireUser, ownedSession, wrap(async (req, res) => {
    if (req.session.ai_bot) throw httpError(400, 'The default session runs the Kamila AI bot and cannot be deleted. Use logout instead.');
    await manager.remove(req.session.id);
    res.json({ ok: true });
  }));

  for (const action of ['start', 'stop', 'restart', 'logout']) {
    router.post(`/sessions/:id/${action}`, requireUser, ownedSession, wrap(async (req, res) => {
      await manager[action](req.session.id);
      res.json(await describeOne(await repo.getSession(req.session.id)));
    }));
  }

  router.get('/sessions/:id/qr', requireUser, ownedSession, wrap(async (req, res) => sendQr(req.session.id, req, res)));

  router.post('/sessions/:id/api-key', requireUser, ownedSession, wrap(async (req, res) => {
    const apiKey = newApiKey();
    const row = await repo.updateSession(req.session.id, { api_key_hash: hashKey(apiKey), api_key_prefix: apiKey.slice(0, 12) });
    res.json({ ...(await describeOne(row)), apiKey });
  }));

  router.post('/sessions/:id/webhook/secret', requireUser, ownedSession, wrap(async (req, res) => {
    res.json(await describeOne(await repo.updateSession(req.session.id, { webhook_secret: newSecret() })));
  }));

  router.post('/sessions/:id/webhook/test', requireUser, ownedSession, wrap(async (req, res) => {
    res.json(await webhooks.test(req.session));
  }));

  // ── WhatsApp profile (what recipients see: name + photo) ──
  // Brands the linked number so OTPs and messages show the business name and
  // logo instead of a bare phone number.
  const PROFILE_NAME_MAX = 25; // WhatsApp's own limit
  const PICTURE_MAX_BYTES = 1_000_000;

  function profileClient(req) {
    const client = manager.getClient(req.session.id);
    if (!client) throw httpError(409, 'Link and connect this WhatsApp number first.', 'session_not_connected');
    return client;
  }
  const isBusinessApp = (client) => ['smba', 'smbi'].includes(client.info?.platform);

  router.get('/sessions/:id/profile', requireUser, ownedSession, wrap(async (req, res) => {
    const client = manager.getClient(req.session.id);
    if (!client) return res.json({ connected: false, name: req.session.push_name, phone: req.session.phone, picture: null });
    const wid = client.info?.wid?._serialized;
    const picture = wid ? await client.getProfilePicUrl(wid).catch(() => null) : null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      connected: true,
      name: client.info?.pushname || req.session.push_name,
      phone: client.info?.wid?.user || req.session.phone,
      picture: picture || null,
      businessApp: isBusinessApp(client),
    });
  }));

  // Body: { name?: string, picture?: "data:image/jpeg;base64,..." | null }
  router.post('/sessions/:id/profile', requireUser, ownedSession, wrap(async (req, res) => {
    const client = profileClient(req);
    const b = req.body || {};
    const done = {};

    if (b.name !== undefined) {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name || name.length > PROFILE_NAME_MAX) throw httpError(400, `name must be 1–${PROFILE_NAME_MAX} characters`);
      const ok = await client.setDisplayName(name).catch((e) => { logger.warn('Gateway', `setDisplayName ${req.session.id}: ${e.message}`); return false; });
      if (!ok) {
        throw httpError(409, isBusinessApp(client)
          ? 'This number uses the WhatsApp Business app. Change the business name in the app: Settings → Business tools → Business profile.'
          : 'WhatsApp did not allow changing the name right now. Try again, or change it on the phone: Settings → Profile.', 'name_not_set');
      }
      await repo.updateSession(req.session.id, { push_name: name }).catch(() => {});
      done.name = name;
    }

    if (b.picture !== undefined) {
      if (b.picture === null) {
        await client.deleteProfilePicture();
        done.picture = null;
      } else {
        const m = typeof b.picture === 'string' && /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.picture);
        if (!m) throw httpError(400, 'picture must be a JPEG, PNG or WebP data URL');
        if (Buffer.byteLength(m[2], 'base64') > PICTURE_MAX_BYTES) throw httpError(413, 'Picture is too large (max 1 MB)');
        const ok = await client.setProfilePicture(new MessageMedia(m[1], m[2], 'profile'))
          .catch((e) => { logger.warn('Gateway', `setProfilePicture ${req.session.id}: ${e.message}`); return false; });
        if (!ok) throw httpError(502, 'WhatsApp did not accept the picture. Try a different image.', 'picture_not_set');
        done.picture = true;
      }
    }

    if (!Object.keys(done).length) throw httpError(400, 'Send `name` and/or `picture`');
    res.json({ ok: true, ...done });
  }));

  // ── Chatbot ──
  router.get('/sessions/:id/chatbot', requireUser, ownedSession, (req, res) => {
    const r = req.session;
    res.json({
      instructions: r.bot_instructions || '',
      knowledgeBase: r.knowledge_base || '',
      answerUrl: r.answer_url || '',
      model: r.gemini_model || '',
      defaultModel: gemini.defaultModel,
      hasOwnKey: !!r.gemini_api_key_enc,
      serverKey: gemini.hasServerKey,
    });
  });

  // Ask the bot something without WhatsApp (dashboard "Test" box).
  router.post('/sessions/:id/chatbot/test', requireUser, ownedSession, rateLimit, wrap(async (req, res) => {
    const { message, history } = req.body || {};
    if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw httpError(400, '`message` is required (max 4000 chars)');
    const hist = Array.isArray(history) ? history.slice(-12)
      .filter((h) => h && (h.role === 'user' || h.role === 'bot') && typeof h.text === 'string')
      .map((h) => ({ role: h.role, text: h.text.slice(0, 4000) })) : [];
    hist.push({ role: 'user', text: message.trim() });
    try {
      const out = await chatbot.answer(req.session, { chatId: 'test', phone: 'test', text: message.trim(), history: hist });
      if (!out) return res.json({ reply: null, reason: 'Add instructions or a knowledge base (and a Gemini key), or an answer URL, so the bot has something to answer with.' });
      res.json(out);
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message, code: err.code || 'ai_error' });
    }
  }));

  router.get('/sessions/:id/messages', requireUser, ownedSession, wrap(async (req, res) => {
    res.json(await repo.recentChatMessages(req.session.id, clampInt(req.query.limit, 1, 200, 50)));
  }));

  router.post('/sessions/:id/publishable-key', requireUser, ownedSession, wrap(async (req, res) => {
    const row = await repo.updateSession(req.session.id, { publishable_key: 'wpk_' + crypto.randomBytes(16).toString('hex') });
    res.json(await describeOne(row));
  }));

  // Daily activity for charts, plus totals for this and the previous period.
  router.get('/sessions/:id/stats', requireUser, ownedSession, wrap(async (req, res) => {
    const days = clampInt(req.query.days, 1, 90, 14);
    const series = (await repo.dailyStats([req.session.id], days * 2)).get(req.session.id) || [];
    const prev = series.slice(0, series.length - days);
    const cur = series.slice(-days);
    const sum = (rows) => rows.reduce((a, r) => ({ otp_sent: a.otp_sent + r.otp_sent, otp_verified: a.otp_verified + r.otp_verified, msg_in: a.msg_in + r.msg_in, msg_out: a.msg_out + r.msg_out }), { otp_sent: 0, otp_verified: 0, msg_in: 0, msg_out: 0 });
    res.json({ days, series: cur, totals: sum(cur), previous: sum(prev) });
  }));

  // Sparklines for the projects grid: one series per project.
  router.get('/stats/overview', requireUser, wrap(async (req, res) => {
    const days = clampInt(req.query.days, 1, 30, 14);
    const rows = await repo.listSessionsFor(req.user.id, req.isOwner);
    const stats = await repo.dailyStats(rows.map((r) => r.id), days);
    res.json(Object.fromEntries([...stats.entries()].map(([id, s]) => [id, s.map((d) => ({ day: d.day, otp: d.otp_sent, messages: d.msg_in + d.msg_out }))])));
  }));

  router.get('/ai/models', requireUser, wrap(async (req, res) => {
    try {
      res.json({ default: gemini.defaultModel, models: await gemini.listModels() });
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message, default: gemini.defaultModel, models: [] });
    }
  }));

  router.get('/sessions/:id/webhook/logs', requireUser, ownedSession, wrap(async (req, res) => {
    res.json(await repo.listWebhookLogs(req.session.id, clampInt(req.query.limit, 1, 200, 50)));
  }));

  // ═══════════════ OTP API (session key) ═══════════════

  router.get('/me', requireSession, wrap(async (req, res) => res.json(await describeOne(req.session, { includeSecret: false }))));

  router.get('/me/qr', requireSession, wrap(async (req, res) => sendQr(req.session.id, req, res)));

  // Send a one-time code. The message text always comes from the session's
  // template, so API callers can't send arbitrary content.
  router.post('/otp/send', requireSession, rateLimit, wrap(async (req, res) => {
    if (req.session.mode === 'chatbot') throw httpError(409, 'This project is an AI chatbot. Switch it to OTP mode to send codes.', 'otp_disabled');
    const client = readyClient(req, res);
    if (!client) return;
    const b = req.body || {};
    const phone = normalizePhone(b.phone ?? b.to);
    if (!phone) throw httpError(400, '`phone` is required in international format, e.g. 255712345678');
    const length = b.length === undefined ? otp.length : Number(b.length);
    if (!Number.isInteger(length) || length < 4 || length > 10) throw httpError(400, '`length` must be 4–10');
    const ttl = b.ttl_seconds === undefined ? otp.ttlSeconds : Number(b.ttl_seconds);
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw httpError(400, '`ttl_seconds` must be 60–3600');
    let code;
    if (b.code !== undefined) {
      if (typeof b.code !== 'string' || !/^\d{4,10}$/.test(b.code)) throw httpError(400, '`code` must be 4–10 digits');
      code = b.code;
    } else {
      code = Array.from({ length }, () => crypto.randomInt(0, 10)).join('');
    }

    const wid = await client.getNumberId(phone);
    if (!wid) throw httpError(404, `${phone} is not on WhatsApp`, 'not_on_whatsapp');

    const id = newOtpId();
    const created = await repo.createOtp({
      id, sessionId: req.session.id, phone, chatId: wid._serialized, codeHash: hashCode(id, code),
      ttlSeconds: ttl, maxAttempts: otp.maxAttempts, cooldownSeconds: otp.resendCooldownSec, maxPerHour: otp.maxPerPhonePerHour,
    });
    if (!created.ok) {
      if (created.error === 'resend_cooldown') {
        res.setHeader('Retry-After', created.retry_after);
        return res.status(429).json({ error: `Wait ${created.retry_after}s before requesting another code for this number`, code: 'resend_cooldown', retry_after: created.retry_after });
      }
      return res.status(429).json({ error: `Max ${otp.maxPerPhonePerHour} codes per hour for this number`, code: 'hourly_limit' });
    }

    const text = renderTemplate(req.session.otp_template || DEFAULT_OTP_TEMPLATE, { code, brand: req.session.name, minutes: Math.ceil(ttl / 60) });
    let msg;
    try {
      msg = await client.sendMessage(wid._serialized, text);
    } catch (err) {
      await repo.setOtpStatus(id, 'FAILED').catch(() => {});
      webhooks.dispatch(req.session.id, 'otp.status', { id, phone, status: 'FAILED' });
      logger.error('Gateway', `OTP send failed (${req.session.id}): ${err.message}`);
      return res.status(502).json({ error: 'WhatsApp failed to send the code', code: 'send_failed', id });
    }
    await repo.setOtpSent(id, msg?.id?._serialized || null);
    webhooks.dispatch(req.session.id, 'otp.sent', { id, phone, expires_at: created.expires_at });
    manager.emit('otp', { id, session: req.session.id, ownerId: req.session.owner_id, status: 'SENT' });
    res.status(201).json({ id, phone, status: 'SENT', expires_at: created.expires_at, expires_in: ttl, resend_after: otp.resendCooldownSec });
  }));

  // Check a code. Business outcomes return 200 with { valid, reason } so
  // clients only branch on one field.
  router.post('/otp/verify', requireSession, wrap(async (req, res) => {
    const b = req.body || {};
    const code = typeof b.code === 'string' || typeof b.code === 'number' ? String(b.code).trim() : '';
    if (!/^\d{4,10}$/.test(code)) throw httpError(400, '`code` (4–10 digits) is required');
    let row;
    if (b.id) {
      row = await repo.getOtp(String(b.id), req.session.id);
    } else {
      const phone = normalizePhone(b.phone ?? b.to);
      if (!phone) throw httpError(400, 'Provide `id` (from /otp/send) or `phone`');
      row = await repo.latestActiveOtp(req.session.id, phone);
    }
    if (!row) return res.json({ valid: false, reason: 'not_found' });

    const fail = (reason, extra = {}) => res.json({ valid: false, reason, id: row.id, ...extra });
    const terminal = { VERIFIED: 'already_used', BLOCKED: 'too_many_attempts', CANCELLED: 'superseded', FAILED: 'not_delivered', EXPIRED: 'expired' };
    if (terminal[row.status]) return fail(terminal[row.status]);
    if (Date.parse(row.expires_at) < Date.now()) {
      await repo.setOtpStatus(row.id, 'EXPIRED');
      return fail('expired');
    }

    const attempt = await repo.otpAttempt(row.id);
    if (!attempt) return fail('already_used'); // status changed under us
    const match = crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(hashCode(row.id, code), 'hex'));
    if (match && attempt.attempts <= attempt.max_attempts) {
      if (!(await repo.markVerified(row.id))) return fail('already_used');
      webhooks.dispatch(req.session.id, 'otp.verified', { id: row.id, phone: row.phone });
      manager.emit('otp', { id: row.id, session: req.session.id, ownerId: req.session.owner_id, status: 'VERIFIED' });
      return res.json({ valid: true, id: row.id, phone: row.phone });
    }
    if (attempt.attempts >= attempt.max_attempts) {
      await repo.setOtpStatus(row.id, 'BLOCKED');
      return fail('too_many_attempts', { attempts_left: 0 });
    }
    return fail('invalid_code', { attempts_left: attempt.max_attempts - attempt.attempts });
  }));

  // ═══════════════ Chat API (session secret key, server-side) ═══════════════
  // Talk to a chatbot project from your own backend. `user` keeps a separate
  // conversation (and history) per end user.
  const chatLimiter = slidingLimiter(chatPerMin);
  router.post('/chat', requireSession, wrap(async (req, res) => {
    if (req.session.mode !== 'chatbot' || req.session.ai_bot) throw httpError(409, 'This project is not an AI chatbot. Switch it to AI chatbot mode first.', 'not_chatbot');
    const { message, user = 'default' } = req.body || {};
    if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw httpError(400, '`message` is required (max 4000 chars)');
    if (typeof user !== 'string' || !/^[A-Za-z0-9_.:@+-]{1,128}$/.test(user)) throw httpError(400, '`user` must be 1–128 characters: letters, digits and _ . : @ + -');
    if (!chatLimiter.hit(req.session.id)) throw httpError(429, `Rate limit: max ${chatPerMin} chat messages per minute per project`, 'rate_limited');
    const out = await chatbot.converse(req.session, { chatId: `api:${user}`, text: message.trim(), channel: 'api' });
    manager.emit('chat', { type: 'replied', session: req.session.id, ownerId: req.session.owner_id });
    if (!out) return res.json({ reply: null, user, reason: 'The bot has no instructions, knowledge base or answer URL yet.' });
    res.json({ reply: out.reply, source: out.source, user });
  }));

  // ═══════════════ Send a message (session secret key, server-side) ═══════════════
  // Plain text to any WhatsApp number, for every project type: notifications,
  // order updates, or starting a conversation the chatbot then continues.
  const perRecipient = slidingLimiter(sendPerRecipientPerMin);
  router.post('/messages', requireSession, rateLimit, wrap(async (req, res) => {
    const b = req.body || {};
    const phone = normalizePhone(b.phone ?? b.to);
    if (!phone) throw httpError(400, '`phone` is required in international format, e.g. 255712345678');
    const text = typeof b.text === 'string' ? b.text.trim() : typeof b.message === 'string' ? b.message.trim() : '';
    if (!text || text.length > 4096) throw httpError(400, '`text` is required (max 4096 chars)');
    if (!perRecipient.hit(`${req.session.id}:${phone}`)) {
      res.setHeader('Retry-After', 60);
      throw httpError(429, `Max ${sendPerRecipientPerMin} messages per minute to the same number`, 'recipient_limited');
    }
    const client = readyClient(req, res);
    if (!client) return;

    const wid = await client.getNumberId(phone);
    if (!wid) throw httpError(404, `${phone} is not on WhatsApp`, 'not_on_whatsapp');
    const chatId = wid._serialized;
    let msg;
    try {
      msg = await client.sendMessage(chatId, text);
    } catch (err) {
      logger.error('Gateway', `Message send failed (${req.session.id}): ${err.message}`);
      return res.status(502).json({ error: 'WhatsApp failed to send the message', code: 'send_failed' });
    }
    const id = msg?.id?._serialized || null;
    // Logged as a bot turn so a chatbot project has context when the person replies.
    await repo.insertChatMessage({ session_id: req.session.id, chat_id: chatId, role: 'bot', text, source: 'api_send', channel: 'whatsapp' })
      .catch((e) => logger.warn('Gateway', `Logging sent message failed: ${e.message}`));
    webhooks.dispatch(req.session.id, 'message.sent', { id, phone, chat_id: chatId, text });
    manager.emit('chat', { type: 'replied', session: req.session.id, ownerId: req.session.owner_id });
    res.status(201).json({ id, phone, status: 'SENT' });
  }));

  // ═══════════════ Website widget (publishable key + allowed origins) ═══════════════
  // Called from browsers. Uses "simple" CORS requests (text/plain body, key in the
  // body or query) so no preflight is needed, and answers only allowed origins.
  const widgetIp = slidingLimiter(20);       // per project + IP, per minute
  const widgetVisitor = slidingLimiter(10);  // per project + visitor, per minute
  const widgetDaily = new Map();             // project -> { day, n }

  async function widgetProject(req, res) {
    const key = String(req.query.key || req.body?.key || req.headers['x-kamila-key'] || '');
    if (!/^wpk_[a-f0-9]{32}$/.test(key)) throw httpError(401, 'Missing or invalid publishable key', 'bad_key');
    const row = await repo.getSessionByPublishableKey(key);
    if (!row) throw httpError(401, 'Unknown publishable key', 'bad_key');
    const origin = req.headers.origin;
    const allowed = (row.allowed_origins || []).includes(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (!origin || !allowed) throw httpError(403, `Origin ${origin || '(none)'} is not allowed. Add it under API keys → Allowed origins.`, 'origin_not_allowed');
    if (row.mode !== 'chatbot' || row.ai_bot) throw httpError(409, 'This project is not an AI chatbot', 'not_chatbot');
    return row;
  }

  router.get('/widget/config', wrap(async (req, res) => {
    const row = await widgetProject(req, res);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...widgetSettings(row), name: row.name });
  }));

  router.post('/widget/chat', express.text({ type: 'text/plain', limit: '16kb' }), wrap(async (req, res) => {
    if (typeof req.body === 'string') {
      try { req.body = JSON.parse(req.body); } catch { throw httpError(400, 'Invalid JSON body'); }
    }
    const row = await widgetProject(req, res);
    const { message, visitor } = req.body || {};
    if (typeof message !== 'string' || !message.trim() || message.length > 1000) throw httpError(400, '`message` is required (max 1000 chars)');
    if (typeof visitor !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(visitor)) throw httpError(400, 'Invalid visitor id');
    const today = new Date().toISOString().slice(0, 10);
    const d = widgetDaily.get(row.id);
    if (!d || d.day !== today) widgetDaily.set(row.id, { day: today, n: 0 });
    if (widgetDaily.get(row.id).n >= widgetPerDay) throw httpError(429, 'This chat is busy right now. Please try again later.', 'daily_limit');
    if (!widgetIp.hit(`${row.id}:${req.ip}`) || !widgetVisitor.hit(`${row.id}:${visitor}`)) throw httpError(429, 'You are sending messages too quickly.', 'rate_limited');
    widgetDaily.get(row.id).n++;
    try {
      const out = await chatbot.converse(row, { chatId: `web:${visitor}`, text: message.trim(), channel: 'widget' });
      manager.emit('chat', { type: 'replied', session: row.id, ownerId: row.owner_id });
      res.json({ reply: out?.reply || null });
    } catch (err) {
      logger.error('Widget', `${row.id}: ${err.message}`);
      res.status(502).json({ error: 'The assistant could not answer right now.', code: 'ai_error' });
    }
  }));

  router.get('/otp', requireSession, wrap(async (req, res) => {
    res.json(await repo.listOtps(req.session.id, clampInt(req.query.limit, 1, 500, 50)));
  }));

  router.get('/otp/:id', requireSession, wrap(async (req, res) => {
    const row = await repo.getOtp(req.params.id, req.session.id);
    if (!row) throw httpError(404, 'OTP not found');
    const { code_hash, chat_id, message_id, session_id, ...pub } = row; // never expose the hash
    res.json(pub);
  }));

  router.get('/contacts/:phone/check', requireSession, wrap(async (req, res) => {
    const client = readyClient(req, res);
    if (!client) return;
    const digits = normalizePhone(req.params.phone);
    if (!digits) throw httpError(400, 'Invalid phone number');
    const wid = await client.getNumberId(digits);
    res.json({ phone: digits, exists: !!wid });
  }));

  // ── QR helper ──
  async function sendQr(id, req, res) {
    const { status } = manager.state(id);
    const qr = manager.qr(id);
    if (!qr) {
      const msg = status === STATUS.WORKING ? 'Session already connected' : `No QR available (status: ${status})`;
      return res.status(404).json({ error: msg, status });
    }
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.format === 'png') {
      res.setHeader('Content-Type', 'image/png');
      return res.send(await QRCode.toBuffer(qr, { width: 320, margin: 1 }));
    }
    res.json({ status, qr, image: await QRCode.toDataURL(qr, { width: 320, margin: 1 }) });
  }

  // ── Errors ──
  router.use((req, res) => res.status(404).json({ error: `No route ${req.method} ${req.baseUrl}${req.path}` }));
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    const status = err.status || 500;
    if (status >= 500) logger.error('Gateway', `API error: ${err.message}`);
    res.status(status).json({ error: status >= 500 && status !== 503 ? 'Internal error' : err.message, ...(err.code ? { code: err.code } : {}) });
  });

  return router;
}

// Sliding one-minute window per key.
function slidingLimiter(perMin) {
  const hits = new Map();
  setInterval(() => {
    const cut = Date.now() - 60_000;
    for (const [k, arr] of hits) if (!arr.some((t) => t > cut)) hits.delete(k);
  }, 60_000).unref();
  return {
    hit(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
      if (arr.length >= perMin) { hits.set(key, arr); return false; }
      arr.push(now);
      hits.set(key, arr);
      return true;
    },
  };
}

function widgetSettings(row) {
  const w = row.widget_settings || {};
  return {
    title: w.title || row.name,
    greeting: w.greeting || `Hi! I'm the ${row.name} assistant. How can I help?`,
    color: w.color || '#111111',
  };
}

function validateWidget(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw httpError(400, 'widget must be an object');
  const out = {};
  if (v.title !== undefined && v.title !== null && v.title !== '') {
    if (typeof v.title !== 'string' || v.title.length > 60) throw httpError(400, 'widget.title: max 60 characters');
    out.title = v.title.trim();
  }
  if (v.greeting !== undefined && v.greeting !== null && v.greeting !== '') {
    if (typeof v.greeting !== 'string' || v.greeting.length > 300) throw httpError(400, 'widget.greeting: max 300 characters');
    out.greeting = v.greeting.trim();
  }
  if (v.color !== undefined && v.color !== null && v.color !== '') {
    if (typeof v.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v.color)) throw httpError(400, 'widget.color must be a hex colour like #111111');
    out.color = v.color.toLowerCase();
  }
  return out;
}

// ["https://shop.example.com", "http://localhost:5173"] → normalised origins.
function validateOrigins(v) {
  if (!Array.isArray(v) || v.length > 20) throw httpError(400, 'allowed_origins must be a list of up to 20 origins');
  const out = new Set();
  for (const raw of v) {
    if (typeof raw !== 'string') throw httpError(400, 'Each origin must be a string');
    let u;
    try { u = new URL(raw.trim()); } catch { throw httpError(400, `Not a valid origin: ${raw}`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw httpError(400, `Origin must be http(s): ${raw}`);
    if (u.pathname !== '/' || u.search || u.hash || u.username) throw httpError(400, `Use just the origin, like https://shop.example.com (got ${raw})`);
    out.add(u.origin);
  }
  return [...out];
}

// '' / null → null; otherwise a trimmed string within `max` chars.
function optText(v, max, field) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw httpError(400, `${field} must be text`);
  const t = v.replace(/\r\n/g, '\n').trim();
  if (t.length > max) throw httpError(400, `${field} is too long (max ${max} characters)`);
  return t || null;
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

// null clears the URL; throws 400 when invalid.
function validateWebhookUrl(v, allowPrivate) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 2000) throw httpError(400, 'webhook_url must be an http(s) URL');
  const err = checkWebhookUrl(v, allowPrivate);
  if (err) throw httpError(400, err);
  return new URL(v).toString();
}

function validateEvents(v) {
  if (v === undefined) return [...DEFAULT_EVENTS];
  const events = Array.isArray(v) ? parseEvents(v) : null;
  if (!events || events.length !== v.length) throw httpError(400, `webhook_events must be a subset of ${WEBHOOK_EVENTS.join(', ')}`);
  return [...new Set(events)];
}

// null → default template; throws 400 when invalid.
function validateTemplate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 500 || !v.includes('{code}')) throw httpError(400, TEMPLATE_RULES);
  const placeholders = v.match(/\{[^}]*\}/g) || [];
  if (placeholders.some((p) => !['{code}', '{brand}', '{minutes}'].includes(p))) throw httpError(400, TEMPLATE_RULES);
  return v;
}

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(code|brand|minutes)\}/g, (_, k) => String(vars[k]));
}

// "+255 712-345-678" → "255712345678"; null if not a plausible E.164 number.
function normalizePhone(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const digits = String(v).replace(/@.*$/, '').replace(/[^0-9]/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}
