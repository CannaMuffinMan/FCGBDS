import crypto from 'crypto';

export function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function bearer(header: string | undefined): string {
  const value = header || '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

export function signSession(secret: string, now = Date.now()): string {
  const exp = String(now + 12 * 60 * 60_000);
  const sig = crypto.createHmac('sha256', secret).update(exp).digest('hex');
  return `${exp}.${sig}`;
}

export function sessionValid(secret: string, token: string, now = Date.now()): boolean {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig) return false;
  const expected = crypto.createHmac('sha256', secret).update(exp).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expires = Number.parseInt(exp, 10);
  return Number.isFinite(expires) && expires >= now;
}

export function readCookie(header: string | undefined, name: string): string {
  const raw = header || '';
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}
