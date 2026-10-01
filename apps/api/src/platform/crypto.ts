import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM for sensitive fields (device passwords, TOTP secrets). Key derived from FIELD_ENCRYPTION_KEY.
const key = () => createHash('sha256').update(process.env.FIELD_ENCRYPTION_KEY ?? process.env.JWT_ACCESS_SECRET ?? '').digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(blob: string): string {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
