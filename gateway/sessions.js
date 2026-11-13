// Runs one whatsapp-web.js client per gateway session, tracks its state,
// reconnects on drops and records OTP delivery acks.
import { EventEmitter } from 'events';
import pkg from 'whatsapp-web.js';
import { ACK_STATUS } from './util.js';

const { Client, LocalAuth } = pkg;

export const STATUS = {
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  SCAN_QR: 'SCAN_QR',
  WORKING: 'WORKING',
  FAILED: 'FAILED',
};

const RECONNECT_MS = 5000;

export class SessionManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.repo        Supabase repository
   * @param {object} opts.webhooks    webhook dispatcher
   * @param {object} opts.logger
   * @param {object} opts.puppeteer   puppeteer launch options
   * @param {(id:string, client:Client)=>void} [opts.onClientCreated] hook for attaching extra handlers (the AI bot)
   */
  constructor({ repo, webhooks, logger, puppeteer, authDir, onClientCreated, onMessage }) {
    super();
    this.repo = repo;
    this.webhooks = webhooks;
    this.logger = logger;
    this.puppeteer = puppeteer;
    this.authDir = authDir; // where WhatsApp logins are kept (LocalAuth)
    this.onClientCreated = onClientCreated;
    this.onMessage = onMessage; // chatbot projects
    this.runtime = new Map(); // id -> { client, status, qr, error, ownerId, reconnectTimer, stopping }
  }

  rt(id) {
    if (!this.runtime.has(id)) this.runtime.set(id, { client: null, status: STATUS.STOPPED, qr: null, error: null, ownerId: undefined, reconnectTimer: null, stopping: false });
    return this.runtime.get(id);
  }

  getClient(id) {
    const r = this.runtime.get(id);
    return r?.status === STATUS.WORKING ? r.client : null;
  }

  state(id) {
    const r = this.runtime.get(id);
    return { status: r?.status || STATUS.STOPPED, hasQr: !!r?.qr, error: r?.error || null };
  }

  qr(id) {
    return this.runtime.get(id)?.qr || null;
  }

  setStatus(id, status, extra = {}) {
    const r = this.rt(id);
    r.status = status;
    if ('qr' in extra) r.qr = extra.qr;
    if ('error' in extra) r.error = extra.error;
    const payload = { id, status, hasQr: !!r.qr, error: r.error || null };
    this.emit('status', { ...payload, ownerId: r.ownerId ?? null });
    this.webhooks.dispatch(id, 'session.status', payload);
  }

  async start(id) {
    const row = await this.repo.getSession(id);
    if (!row) throw new Error('Session not found');
    const r = this.rt(id);
    r.ownerId = row.owner_id;
    if (r.client && r.status !== STATUS.STOPPED && r.status !== STATUS.FAILED) return;
    clearTimeout(r.reconnectTimer);
    r.stopping = false;

    // The legacy single-session bot used LocalAuth() with no clientId; keep that
    // for the "default" session so an existing login is not lost.
    const dataPath = this.authDir || undefined;
    const auth = id === 'default' ? new LocalAuth({ dataPath }) : new LocalAuth({ clientId: id, dataPath });
    const client = new Client({ authStrategy: auth, puppeteer: this.puppeteer });
    r.client = client;
    this.wire(id, client);
    try { this.onClientCreated?.(id, client); } catch (e) { this.logger.error('Gateway', `onClientCreated failed for ${id}: ${e.message}`); }

    this.setStatus(id, STATUS.STARTING, { qr: null, error: null });
    this.logger.info('Gateway', `Starting session ${id}`);
    client.initialize().catch((err) => {
      if (r.client !== client || r.stopping) return;
      this.logger.error('Gateway', `Session ${id} failed to start: ${err.message}`);
      r.client = null;
      this.setStatus(id, STATUS.FAILED, { qr: null, error: err.message });
    });
  }

  wire(id, client) {
    const r = this.rt(id);
    const current = () => r.client === client;
    const saveIdentity = (phone, name) => this.repo.updateSession(id, { phone, push_name: name })
      .catch((e) => this.logger.warn('Gateway', `Saving identity for ${id} failed: ${e.message}`));

    client.on('qr', (qr) => {
      if (current()) this.setStatus(id, STATUS.SCAN_QR, { qr });
    });

    client.on('ready', async () => {
      if (!current()) return;
      const phone = client.info?.wid?.user || null;
      await saveIdentity(phone, client.info?.pushname || null);
      this.logger.info('Gateway', `Session ${id} ready (${phone})`);
      this.setStatus(id, STATUS.WORKING, { qr: null, error: null });
    });

    client.on('auth_failure', (msg) => {
      if (current()) this.setStatus(id, STATUS.FAILED, { qr: null, error: `Auth failure: ${msg}` });
    });

    client.on('disconnected', (reason) => {
      if (!current() || r.stopping) return;
      this.logger.warn('Gateway', `Session ${id} disconnected: ${reason}`);
      r.client = null;
      client.destroy().catch(() => {});
      if (String(reason).toUpperCase() === 'LOGOUT') {
        saveIdentity(null, null);
        this.setStatus(id, STATUS.STOPPED, { qr: null, error: 'Logged out from phone' });
        return;
      }
      this.setStatus(id, STATUS.STARTING, { qr: null, error: `Disconnected: ${reason}` });
      r.reconnectTimer = setTimeout(() => this.start(id).catch(() => {}), RECONNECT_MS);
    });

    // Incoming messages go to the chatbot (it ignores OTP-mode projects).
    client.on('message', (msg) => {
      if (!current() || !this.onMessage) return;
      this.onMessage(id, client, msg, (e) => this.emit('chat', { ...e, session: id, ownerId: r.ownerId ?? null }));
    });

    // Delivery acks for OTP messages we sent.
    client.on('message_ack', async (msg, ack) => {
      if (!current() || !msg.fromMe) return;
      const status = ACK_STATUS[ack];
      if (!status || status === 'PENDING') return;
      let otp;
      try { otp = await this.repo.ackOtp(msg.id?._serialized, id, status); } catch { return; }
      if (!otp) return; // not an OTP message, or already verified/expired
      this.emit('otp', { id: otp.id, session: id, ownerId: r.ownerId ?? null, status });
      this.webhooks.dispatch(id, 'otp.status', { id: otp.id, phone: otp.phone, status });
    });
  }

  async stop(id) {
    const r = this.rt(id);
    r.stopping = true;
    clearTimeout(r.reconnectTimer);
    const client = r.client;
    r.client = null;
    if (client) { try { await client.destroy(); } catch {} }
    this.setStatus(id, STATUS.STOPPED, { qr: null, error: null });
  }

  async restart(id) {
    await this.stop(id);
    await this.start(id);
  }

  // Unlinks the device from the phone and wipes the stored auth.
  async logout(id) {
    const r = this.rt(id);
    r.stopping = true;
    clearTimeout(r.reconnectTimer);
    const client = r.client;
    r.client = null;
    if (client) {
      try { await client.logout(); } catch (e) { this.logger.warn('Gateway', `Logout ${id}: ${e.message}`); }
      try { await client.destroy(); } catch {}
    }
    await this.repo.updateSession(id, { phone: null, push_name: null }).catch(() => {});
    this.setStatus(id, STATUS.STOPPED, { qr: null, error: null });
  }

  // Deletes the session row (OTPs and webhook logs cascade).
  async remove(id) {
    const ownerId = this.rt(id).ownerId ?? null;
    await this.logout(id);
    await this.repo.deleteSession(id);
    this.runtime.delete(id);
    this.emit('status', { id, status: 'DELETED', ownerId });
  }

  async startAll() {
    for (const row of await this.repo.listAllSessions()) {
      if (row.auto_start) await this.start(row.id).catch((e) => this.logger.error('Gateway', `Start ${row.id}: ${e.message}`));
    }
  }

  async stopAll() {
    for (const r of this.runtime.values()) {
      r.stopping = true;
      clearTimeout(r.reconnectTimer);
      if (r.client) { try { await r.client.destroy(); } catch {} }
      r.client = null;
    }
  }
}
