// Shared constants and helpers for the OTP gateway.
import crypto from 'crypto';
import net from 'net';

export const WEBHOOK_EVENTS = ['otp.sent', 'otp.status', 'otp.verified', 'message.received', 'message.replied', 'message.sent', 'session.status'];
export const DEFAULT_EVENTS = [...WEBHOOK_EVENTS];
export const MODES = ['otp', 'chatbot'];
export const DEFAULT_OTP_TEMPLATE = '*{code}* is your {brand} verification code. It expires in {minutes} minutes. Do not share this code with anyone.';
export const ACTIVE_OTP = ['PENDING', 'SENT', 'DELIVERED', 'READ'];

// WhatsApp ack → OTP status
export const ACK_STATUS = { '-1': 'FAILED', 0: 'PENDING', 1: 'SENT', 2: 'DELIVERED', 3: 'READ', 4: 'READ' };

export const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
export const hashKey = sha256;
export const newApiKey = () => 'wsk_' + crypto.randomBytes(24).toString('hex');
export const newSecret = () => 'whsec_' + crypto.randomBytes(24).toString('hex');
export const newSessionId = () => 's_' + crypto.randomBytes(5).toString('hex');
export const newOtpId = () => 'otp_' + crypto.randomBytes(10).toString('hex');

export function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

export function parseEvents(v) {
  const arr = Array.isArray(v) ? v : (() => { try { return JSON.parse(v); } catch { return []; } })();
  return Array.isArray(arr) ? arr.filter((e) => WEBHOOK_EVENTS.includes(e)) : [];
}

// Loopback, private, link-local, CGNAT, multicast/reserved and ULA ranges.
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
    return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
  }
  return false;
}
