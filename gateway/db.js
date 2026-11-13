// Supabase (Postgres) data access for the OTP gateway.
// Uses the service-role key, so every query here must scope by session/owner itself.
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { ACTIVE_OTP, DEFAULT_EVENTS } from './util.js';

export function createRepo({ url, serviceRoleKey }) {
  const sb = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  async function q(promise) {
    const { data, error } = await promise;
    if (error) {
      const e = new Error(`Database error: ${error.message}`);
      e.status = 500;
      e.dbCode = error.code;
      throw e;
    }
    return data;
  }

  const SESSION_COLS = 'id, owner_id, name, api_key_hash, api_key_prefix, webhook_url, webhook_secret, webhook_events, otp_template, ai_bot, auto_start, phone, push_name, created_at, mode, bot_instructions, knowledge_base, answer_url, gemini_api_key_enc, gemini_model, publishable_key, allowed_origins, widget_settings';
  const OTP_PUBLIC_COLS = 'id, phone, status, attempts, max_attempts, expires_at, verified_at, created_at, updated_at';

  return {
    sb,

    // Fails fast with a helpful message if the migration hasn't been applied.
    async ping() {
      const { error } = await sb.from('gw_sessions').select('id', { head: true, count: 'exact' }).limit(1);
      if (error) throw new Error(`Supabase not ready (${error.message}). Did you run supabase/migrations/*.sql?`);
      const cols = await sb.from('gw_sessions').select(SESSION_COLS).limit(1);
      const msgs = await sb.from('gw_messages').select('id, channel', { head: true }).limit(1);
      if (cols.error || msgs.error) {
        throw new Error(`Database schema is out of date (${(cols.error || msgs.error).message}). Run every file in supabase/migrations/ in order (newest: 20261110090000_public_api_and_stats.sql), then restart.`);
      }
    },

    // Returns the stored value, creating it with `make()` the first time (safe across instances).
    async getOrCreateSetting(key, make) {
      const existing = await q(sb.from('gw_settings').select('value').eq('key', key).maybeSingle());
      if (existing) return existing.value;
      await q(sb.from('gw_settings').upsert({ key, value: make() }, { onConflict: 'key', ignoreDuplicates: true }));
      return (await q(sb.from('gw_settings').select('value').eq('key', key).single())).value;
    },

    // ── Sessions ──
    async listAllSessions() {
      return q(sb.from('gw_sessions').select(SESSION_COLS).order('created_at'));
    },
    async listSessionsFor(userId, includeSystem) {
      const own = await q(sb.from('gw_sessions').select(SESSION_COLS).eq('owner_id', userId).order('created_at'));
      if (!includeSystem) return own;
      const sys = await q(sb.from('gw_sessions').select(SESSION_COLS).is('owner_id', null).order('created_at'));
      return [...sys, ...own];
    },
    async getSession(id) {
      return q(sb.from('gw_sessions').select(SESSION_COLS).eq('id', id).maybeSingle());
    },
    async getSessionByPublishableKey(key) {
      return q(sb.from('gw_sessions').select(SESSION_COLS).eq('publishable_key', key).maybeSingle());
    },
    async getSessionByKeyHash(hash) {
      return q(sb.from('gw_sessions').select(SESSION_COLS).eq('api_key_hash', hash).maybeSingle());
    },
    async countSessions(ownerId) {
      let query = sb.from('gw_sessions').select('id', { head: true, count: 'exact' });
      if (ownerId !== undefined) query = query.eq('owner_id', ownerId);
      const { count, error } = await query;
      if (error) throw new Error(`Database error: ${error.message}`);
      return count || 0;
    },
    async insertSession(row) {
      return q(sb.from('gw_sessions').insert({ webhook_events: DEFAULT_EVENTS, ...row }).select(SESSION_COLS).single());
    },
    async updateSession(id, patch) {
      return q(sb.from('gw_sessions').update(patch).eq('id', id).select(SESSION_COLS).single());
    },
    async deleteSession(id) {
      await q(sb.from('gw_sessions').delete().eq('id', id));
    },
    async sessionIdsForOwner(ownerId) {
      return (await q(sb.from('gw_sessions').select('id').eq('owner_id', ownerId))).map((r) => r.id);
    },

    // ── OTPs ──
    async createOtp(a) {
      return q(sb.rpc('gw_create_otp', {
        p_id: a.id, p_session: a.sessionId, p_phone: a.phone, p_chat: a.chatId, p_hash: a.codeHash,
        p_ttl_seconds: a.ttlSeconds, p_max_attempts: a.maxAttempts,
        p_cooldown_seconds: a.cooldownSeconds, p_max_per_hour: a.maxPerHour,
      }));
    },
    async setOtpSent(id, messageId) {
      await q(sb.from('gw_otps').update({ status: 'SENT', message_id: messageId, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'PENDING'));
    },
    async setOtpStatus(id, status) {
      await q(sb.from('gw_otps').update({ status, updated_at: new Date().toISOString() }).eq('id', id));
    },
    // Delivery acks only move a code forward while it is still usable.
    async ackOtp(messageId, sessionId, status) {
      const rows = await q(sb.from('gw_otps').update({ status, updated_at: new Date().toISOString() })
        .eq('message_id', messageId).eq('session_id', sessionId).in('status', ['PENDING', 'SENT', 'DELIVERED'])
        .select('id, phone'));
      return rows[0] || null;
    },
    async otpAttempt(id) {
      const rows = await q(sb.rpc('gw_otp_attempt', { p_id: id }));
      return rows?.[0] || null;
    },
    // Conditional update so two concurrent correct guesses can't both succeed.
    async markVerified(id) {
      const now = new Date().toISOString();
      const rows = await q(sb.from('gw_otps').update({ status: 'VERIFIED', verified_at: now, updated_at: now })
        .eq('id', id).in('status', ACTIVE_OTP).select('id'));
      return rows.length > 0;
    },
    async getOtp(id, sessionId) {
      return q(sb.from('gw_otps').select('*').eq('id', id).eq('session_id', sessionId).maybeSingle());
    },
    async latestActiveOtp(sessionId, phone) {
      return q(sb.from('gw_otps').select('*').eq('session_id', sessionId).eq('phone', phone)
        .in('status', ACTIVE_OTP).order('created_at', { ascending: false }).limit(1).maybeSingle());
    },
    async listOtps(sessionId, limit) {
      return q(sb.from('gw_otps').select(OTP_PUBLIC_COLS).eq('session_id', sessionId).order('created_at', { ascending: false }).limit(limit));
    },
    // Codes WhatsApp never accepted (still PENDING with no message id) are
    // failures, not expiries, so they don't count as sent.
    async expireOtps() {
      return q(sb.from('gw_otps').update({ status: 'EXPIRED', updated_at: new Date().toISOString() })
        .in('status', ACTIVE_OTP).or('status.neq.PENDING,message_id.not.is.null')
        .lt('expires_at', new Date().toISOString()).select('id, session_id'));
    },
    async failUnsentOtps(olderThanSec = 120) {
      return q(sb.from('gw_otps').update({ status: 'FAILED', updated_at: new Date().toISOString() })
        .eq('status', 'PENDING').is('message_id', null)
        .lt('created_at', new Date(Date.now() - olderThanSec * 1000).toISOString()).select('id, session_id, phone'));
    },
    // Failed codes are removed shortly after they fail, so they don't linger in lists or stats.
    async deleteFailedOtps(afterMinutes = 10) {
      return q(sb.from('gw_otps').delete().eq('status', 'FAILED')
        .lt('updated_at', new Date(Date.now() - afterMinutes * 60000).toISOString()).select('id, session_id'));
    },
    async purgeOld(days = 7, chatDays = 30) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      await q(sb.from('gw_otps').delete().lt('created_at', cutoff));
      await q(sb.from('gw_webhook_logs').delete().lt('created_at', cutoff));
      await q(sb.from('gw_messages').delete().lt('created_at', new Date(Date.now() - chatDays * 86400000).toISOString()));
    },
    async todayCounts(ids) {
      if (!ids.length) return new Map();
      const rows = await q(sb.rpc('gw_today_counts', { p_ids: ids }));
      return new Map(rows.map((r) => [r.session_id, { sent: Number(r.sent), verified: Number(r.verified) }]));
    },

    // ── Chatbot conversations ──
    async insertChatMessage(row) {
      await q(sb.from('gw_messages').insert(row));
    },
    async chatHistory(sessionId, chatId, limit) {
      const rows = await q(sb.from('gw_messages').select('role, text, created_at').eq('session_id', sessionId).eq('chat_id', chatId)
        .order('id', { ascending: false }).limit(limit));
      return rows.reverse();
    },
    async recentChatMessages(sessionId, limit) {
      return q(sb.from('gw_messages').select('id, chat_id, role, text, source, channel, created_at').eq('session_id', sessionId)
        .order('id', { ascending: false }).limit(limit));
    },
    // Zero-filled daily series per project: Map(id -> [{ day, otp_sent, otp_verified, msg_in, msg_out }])
    async dailyStats(ids, days) {
      if (!ids.length) return new Map();
      const rows = await q(sb.rpc('gw_daily_stats', { p_ids: ids, p_days: days }));
      const out = new Map(ids.map((id) => [id, []]));
      for (const r of rows) {
        out.get(r.session_id)?.push({ day: r.day, otp_sent: Number(r.otp_sent), otp_verified: Number(r.otp_verified), msg_in: Number(r.msg_in), msg_out: Number(r.msg_out) });
      }
      return out;
    },
    async todayChatCounts(ids) {
      if (!ids.length) return new Map();
      const rows = await q(sb.rpc('gw_today_chat_counts', { p_ids: ids }));
      return new Map(rows.map((r) => [r.session_id, { received: Number(r.received), replied: Number(r.replied) }]));
    },

    // ── Webhook logs ──
    async insertWebhookLog(row) {
      await q(sb.from('gw_webhook_logs').insert(row));
    },
    async listWebhookLogs(sessionId, limit) {
      return q(sb.from('gw_webhook_logs').select('*').eq('session_id', sessionId).order('id', { ascending: false }).limit(limit));
    },
  };
}

export const randomHex = (n) => crypto.randomBytes(n).toString('hex');
