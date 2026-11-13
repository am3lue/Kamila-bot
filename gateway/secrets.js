// AES-256-GCM for small secrets stored in the database (per-project Gemini keys).
import crypto from 'crypto';

export function createSealer(keyMaterial) {
  const key = crypto.createHash('sha256').update(String(keyMaterial)).digest();
  return {
    seal(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
    },
    open(sealed) {
      if (!sealed) return null;
      try {
        const [v, iv, tag, enc] = String(sealed).split('.');
        if (v !== 'v1') return null;
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}
