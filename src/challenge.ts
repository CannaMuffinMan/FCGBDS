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
