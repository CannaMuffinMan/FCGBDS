import crypto from 'crypto';

export function issueChallengeToken(secret: string, now = Date.now()): string {
  const key = secret || 'ephemeral-dev-only';
  const exp = String(now + 10 * 60_000);
  const sig = crypto.createHmac('sha256', key).update(exp).digest('hex');
  return `${exp}.${sig}`;
}

export function verifyChallengeToken(secret: string, token: string, now = Date.now()): boolean {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig) return false;
  const key = secret || 'ephemeral-dev-only';
  const expected = crypto.createHmac('sha256', key).update(exp).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  const expires = Number.parseInt(exp, 10);
  return Number.isFinite(expires) && expires >= now;
}

export function challengePage(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Visitor check</title>
</head>
<body>
  <main>
    <h1>Visitor check</h1>
    <p>This is a text-only check. No images or timers are required.</p>
    <form method="post" action="/__fcgbds/challenge">
      <label for="answer">Type CONTINUE to proceed</label>
      <input id="answer" name="answer" autocomplete="off" required>
      <input type="hidden" name="token" value="${token}">
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`;
}

export function challengePassed(answer: unknown, token: string, secret: string): boolean {
  if (String(answer || '').trim().toUpperCase() !== 'CONTINUE') return false;
  return verifyChallengeToken(secret, token);
}

export function ipHash(ip: string): string {
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 16);
}

/** Clearance is bound to the client IP hash and expires with the token. */
export function issueClearance(secret: string, ip: string, now = Date.now()): string {
  const key = secret || 'ephemeral-dev-only';
  const exp = String(now + 30 * 60_000);
  const bound = ipHash(ip);
  const sig = crypto.createHmac('sha256', key).update(`${exp}.${bound}`).digest('hex');
  return `${exp}.${bound}.${sig}`;
}

export function clearanceValid(secret: string, token: string, ip: string, now = Date.now()): boolean {
  const [exp, bound, sig] = String(token || '').split('.');
  if (!exp || !bound || !sig) return false;
  if (bound !== ipHash(ip)) return false;
  const key = secret || 'ephemeral-dev-only';
  const expected = crypto.createHmac('sha256', key).update(`${exp}.${bound}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expires = Number.parseInt(exp, 10);
  return Number.isFinite(expires) && expires >= now;
}

export function readClearance(headers: Record<string, string | string[] | undefined>): string {
  const direct = headers['x-fcgbds-clearance'] ?? headers['X-FCGBDS-Clearance'];
  if (Array.isArray(direct)) return direct[0] || '';
  if (direct) return String(direct);
  const cookie = headers.cookie ?? headers.Cookie;
  const raw = Array.isArray(cookie) ? cookie.join(';') : String(cookie || '');
  const match = raw.match(/(?:^|;\s*)fcgbds_clearance=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
