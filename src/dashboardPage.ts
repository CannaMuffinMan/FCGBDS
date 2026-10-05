export function dashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FCGBDS</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 46rem; color: #1b1b1b; }
    h1 { font-size: 1.4rem; }
    dl { display: grid; grid-template-columns: 12rem 1fr; gap: 0.4rem 1rem; }
    dt { font-weight: 600; }
    button { margin-right: 0.5rem; }
    .note { color: #333; font-size: 0.92rem; }
    form { margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>FCGBDS owner dashboard</h1>
  <p class="note">Counts are for this process since it started, plus whatever the configured store retained for mode and lists. They are not a global block total.</p>
  <form id="login">
    <label>Dashboard password <input id="password" type="password" autocomplete="current-password"></label>
    <button type="submit">Sign in</button>
  </form>
  <section id="stats" hidden>
    <dl>
      <dt>Mode</dt><dd id="mode">—</dd>
      <dt>Store</dt><dd id="store">—</dd>
      <dt>Checks issued</dt><dd id="issued">0</dd>
      <dt>Passed</dt><dd id="passed">0</dd>
      <dt>Not verified</dt><dd id="open">0</dd>
      <dt>Stopped</dt><dd id="stopped">0</dd>
    </dl>
    <p class="note">Not verified = failed visitor checks plus checks that were issued and have not been passed or failed yet. Stopped = requests blocked while enforce mode was on.</p>
    <p>
      <button type="button" id="observe">Set observe</button>
      <button type="button" id="enforce">Set enforce</button>
    </p>
    <p class="note" id="mode-note"></p>
  </section>
  <script>
    const login = document.getElementById('login');
    const stats = document.getElementById('stats');
    async function refresh() {
      const res = await fetch('/v1/stats', { credentials: 'same-origin' });
      if (res.status === 401) { stats.hidden = true; login.hidden = false; return; }
      const body = await res.json();
      stats.hidden = false;
      login.hidden = true;
      document.getElementById('mode').textContent = body.mode;
      document.getElementById('store').textContent = body.store;
      document.getElementById('issued').textContent = String(body.checksIssued);
      document.getElementById('passed').textContent = String(body.passed);
      document.getElementById('open').textContent = String(body.notVerified);
      document.getElementById('stopped').textContent = String(body.stopped);
    }
    login.addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = document.getElementById('password').value;
      const res = await fetch('/v1/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password })
      });
      if (!res.ok) { alert('Sign-in failed'); return; }
      await refresh();
    });
    async function setMode(mode) {
      const res = await fetch('/v1/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ mode })
      });
      const body = await res.json();
      document.getElementById('mode-note').textContent = res.ok
        ? 'Mode saved in the store. It applies until you change it.'
        : (body.message || 'Mode was not changed');
      await refresh();
    }
    document.getElementById('observe').addEventListener('click', () => setMode('observe'));
    document.getElementById('enforce').addEventListener('click', () => setMode('enforce'));
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

export function wallScript(): string {
  return `(() => {
  const node = document.querySelector('[data-fcgbds-wall]');
  if (!node) return;
  const endpoint = node.getAttribute('data-endpoint') || '/v1/wall';
  fetch(endpoint).then((res) => res.json()).then((body) => {
    node.textContent = 'Checks issued ' + body.checksIssued + ', passed ' + body.passed + ', not verified ' + body.notVerified + ', stopped ' + body.stopped;
  }).catch(() => {
    node.textContent = 'Wall stats are unavailable.';
  });
})();`;
}
