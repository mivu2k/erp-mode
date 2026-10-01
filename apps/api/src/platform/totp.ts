import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Buffer): string {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? []).map((c) => B32[parseInt(c.padEnd(5, '0'), 2)]).join('');
}

function unbase32(s: string): Buffer {
  const bits = s.replace(/=+$/, '').toUpperCase().split('').map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}

export const newTotpSecret = () => base32(randomBytes(20));

/** RFC 6238 TOTP (SHA-1, 6 digits, 30s). */
export function totp(secret: string, at = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = createHmac('sha1', unbase32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Accepts the previous/next window to tolerate phone clock drift. */
export function verifyTotp(secret: string, code: string, at = Date.now()): boolean {
  return [-30_000, 0, 30_000].some((d) => totp(secret, at + d) === code.trim());
}
