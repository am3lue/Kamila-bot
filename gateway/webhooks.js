// Webhook delivery with HMAC signatures, retry/backoff and an SSRF guard
// (webhook URLs are set by any signed-in user, so they must not reach the
// server's own network).
import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import axios from 'axios';
import { parseEvents, isPrivateIp } from './util.js';

const RETRY_DELAYS_MS = [0, 5000, 30000];

export function signPayload(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// Checked at connect time, so DNS rebinding can't swap in a private address later.
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (addrs.some((a) => isPrivateIp(a.address))) {
      return cb(Object.assign(new Error(`Webhook host ${hostname} resolves to a private address`), { code: 'EPRIVATE' }));
    }
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

// Returns an error message if the URL is not acceptable, else null.
export function checkWebhookUrl(url, allowPrivate) {
  let u;
  try { u = new URL(url); } catch { return 'Invalid URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Webhook URL must be http(s)';
  if (u.username || u.password) return 'Webhook URL must not contain credentials';
  if (allowPrivate) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'Webhook URL must be a public address';
  if (net.isIP(host) && isPrivateIp(host)) return 'Webhook URL must be a public address';
  return null;
}

export function createWebhookDispatcher({ repo, logger, timeoutMs = 10000, allowPrivate = false }) {
  const agentOpts = allowPrivate ? {} : { lookup: guardedLookup };
  const client = axios.create({
    timeout: timeoutMs,
    maxRedirects: 0,
    maxContentLength: 64 * 1024,
    validateStatus: () => true,
    httpAgent: new http.Agent(agentOpts),
    httpsAgent: new https.Agent(agentOpts),
  });

  async function deliver(session, event, body, attempt) {
    const ts = Math.floor(Date.now() / 1000);
    const started = Date.now();
    let statusCode = null;
    let error = checkWebhookUrl(session.webhook_url, allowPrivate);
    if (!error) {
      try {
        const res = await client.post(session.webhook_url, body, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Kamila-OTP-Webhook/1.0',
            'X-Webhook-Event': event,
            'X-Webhook-Session': session.id,
            'X-Webhook-Timestamp': String(ts),
            'X-Webhook-Signature': `sha256=${signPayload(session.webhook_secret, ts, body)}`,
          },
          transformRequest: [(d) => d], // body is already a JSON string; sign exactly what we send
        });
        statusCode = res.status;
        if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      } catch (err) {
        error = err.cause?.code === 'EPRIVATE' || err.code === 'EPRIVATE' ? 'Blocked: private address' : (err.code || err.message);
      }
    }
    repo.insertWebhookLog({
      session_id: session.id, event, url: session.webhook_url, attempt,
      status_code: statusCode, error, duration_ms: Date.now() - started,
    }).catch((e) => logger.warn('Webhook', `Log insert failed: ${e.message}`));
    return { ok: !error, statusCode, error };
  }

  // Fire-and-forget with retries. Re-reads the session before each attempt so
  // URL/secret changes (or deletion) take effect immediately.
  function dispatch(sessionId, event, data) {
    const body = JSON.stringify({ event, session: sessionId, timestamp: Date.now(), data });
    (async () => {
      for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
        if (RETRY_DELAYS_MS[i]) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
        const session = await repo.getSession(sessionId);
        if (!session?.webhook_url || !parseEvents(session.webhook_events).includes(event)) return;
        const res = await deliver(session, event, body, i + 1);
        if (res.ok) return;
        logger.warn('Webhook', `${sessionId} ${event} attempt ${i + 1} failed: ${res.error}`);
      }
    })().catch((e) => logger.error('Webhook', `Dispatch failed: ${e.message}`));
  }

  // Single synchronous delivery used by the "Send test" button.
  async function test(session) {
    if (!session?.webhook_url) return { ok: false, error: 'No webhook URL configured' };
    const body = JSON.stringify({ event: 'webhook.test', session: session.id, timestamp: Date.now(), data: { hello: 'world' } });
    return deliver(session, 'webhook.test', body, 1);
  }

  // Signed request whose JSON response we use (the chatbot "answer URL").
  async function call(session, url, event, data, timeout = 10000) {
    const blocked = checkWebhookUrl(url, allowPrivate);
    if (blocked) return { ok: false, error: blocked };
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ event, session: session.id, timestamp: Date.now(), data });
    try {
      const res = await client.post(url, body, {
        timeout,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Kamila-Webhook/1.0',
          'X-Webhook-Event': event,
          'X-Webhook-Session': session.id,
          'X-Webhook-Timestamp': String(ts),
          'X-Webhook-Signature': `sha256=${signPayload(session.webhook_secret, ts, body)}`,
        },
        transformRequest: [(d) => d],
      });
      if (res.status < 200 || res.status >= 300) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true, data: typeof res.data === 'object' ? res.data : null };
    } catch (err) {
      return { ok: false, error: err.cause?.code === 'EPRIVATE' || err.code === 'EPRIVATE' ? 'Blocked: private address' : (err.code || err.message) };
    }
  }

  return { dispatch, test, call };
}
