/**
 * FCG Bot Defense - Legit Session Traffic Worker
 * Trigger: POST /run { "triggerKey": "<TRIGGER_KEY>" }
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertAllowedTarget(baseUrl, env) {
  const defaults = ['PLACEHOLDER_API_HOST', 'PLACEHOLDER_SECONDARY_API_HOST', 'bdscore.PLACEHOLDER_WEB_HOST'];
  const configured = String(env.ALLOWED_TARGET_HOSTS || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const allowed = [...new Set([...defaults, ...configured])];
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (!allowed.includes(host)) {
    throw new Error(`TARGET_API host '${host}' is not allowed`);
  }
}

function resolveTargetBaseUrl(payload, env) {
  const payloadTarget = typeof payload?.targetApi === 'string' ? payload.targetApi.trim() : '';
  return payloadTarget || env.TARGET_API || 'https://PLACEHOLDER_API_BASE_URL';
}

function buildWaves() {
  const sessionHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Origin': 'https://PLACEHOLDER_WEB_ORIGIN',
    'Referer': 'https://PLACEHOLDER_WEB_ORIGIN/app',
    'Content-Type': 'application/json',
  };

  return [
    {
      id: 'LS1',
      name: 'Legit Session User Poll',
      count: 100,
      expectBlock: false,
      note: 'User session lookups with unique cookies.',
      path: '/api/auth/user',
      method: 'GET',
      headers: sessionHeaders,
      body: () => '',
    },
    {
      id: 'LS2',
      name: 'Legit Session Wallet Poll',
      count: 100,
      expectBlock: false,
      note: 'Wallet/status reads from active-like sessions.',
      path: '/api/wallet/status',
      method: 'GET',
      headers: sessionHeaders,
      body: () => '',
    },
    {
      id: 'LS3',
      name: 'Legit Session Ecosystem Feed Poll',
      count: 100,
      expectBlock: false,
      note: 'Feed-style GETs from browser clients.',
      path: '/api/ecosystem/feed',
      method: 'GET',
      headers: sessionHeaders,
      body: () => '',
    },
    {
      id: 'LS4',
      name: 'Legit Session Login Refresh Attempt',
      count: 100,
      expectBlock: false,
      note: 'Session refresh/login-like POST payloads.',
      path: '/api/auth/email/login',
      method: 'POST',
      headers: sessionHeaders,
      body: (i) => JSON.stringify({
        email: `session.user.${i}@example.com`,
        password: `SessionPass${i}!`,
      }),
    },
    {
      id: 'LS5',
      name: 'Legit Session Health Poll',
      count: 100,
      expectBlock: false,
      note: 'Service health checks.',
      path: '/api/health',
      method: 'GET',
      headers: sessionHeaders,
      body: () => '',
    },
  ];
}

async function runBot(baseUrl, wave, botIndex, bypassHeader) {
  const routeTag = ['home', 'profile', 'rewards', 'watch'][botIndex % 4];
  const query = wave.path.includes('?') ? '&' : '?';
  const url = `${baseUrl}${wave.path}${query}view=${routeTag}&nonce=${Date.now()}-${botIndex}`;

  const headers = {
    ...wave.headers,
    'X-Test-Run-Id': `legit-session-${wave.id}`,
    'X-Legit-Traffic': 'true',
    'X-Session-Id': crypto.randomUUID(),
    'Cookie': `sessionId=${crypto.randomUUID()}; csrfToken=${crypto.randomUUID().replace(/-/g, '')}`,
  };

  if (bypassHeader) {
    headers['X-FCG-Test-Token'] = bypassHeader;
  }

  const jitter = Math.floor(90 + Math.random() * 410);
  if (jitter > 0) await sleep(jitter);

  const body = wave.body(botIndex);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: wave.method,
      headers,
      body: wave.method === 'GET' ? undefined : body,
    });

    const durationMs = Date.now() - started;
    const blocked = response.status === 403 || response.status === 429;

    let blockCode = '';
    try {
      const parsed = await response.clone().json();
      blockCode = parsed.code || '';
    } catch (_) {}

    return {
      wave: wave.id,
      waveName: wave.name,
      bot: botIndex,
      status: response.status,
      blocked,
      blockCode,
      expectBlock: false,
      FAILURE: false,
      FALSE_POS: blocked,
      startedAt: new Date(started).toISOString(),
      durationMs,
      path: wave.path,
      bodySample: String(body || '').slice(0, 80),
      error: '',
    };
  } catch (err) {
    return {
      wave: wave.id,
      waveName: wave.name,
      bot: botIndex,
      status: 0,
      blocked: false,
      blockCode: '',
      expectBlock: false,
      FAILURE: false,
      FALSE_POS: false,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      path: wave.path,
      bodySample: String(body || '').slice(0, 80),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, colo: request.cf?.colo || 'unknown' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/waves') {
      const manifest = buildWaves().map((w) => ({
        id: w.id,
        name: w.name,
        count: w.count,
        expectBlock: w.expectBlock,
        note: w.note,
      }));
      return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname !== '/run' || request.method !== 'POST') {
      return new Response('POST /run to trigger test', { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      return new Response('Invalid JSON body', { status: 400 });
    }

    if (!env.TRIGGER_KEY || payload.triggerKey !== env.TRIGGER_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    const baseUrl = resolveTargetBaseUrl(payload, env);
    assertAllowedTarget(baseUrl, env);

    const bypassHeader = env.WAF_BYPASS_TOKEN || '';
    const waveId = payload.waveId || null;
    const batchStart = Number(payload.batchStart || 1);
    const batchCount = payload.batchCount ? Number(payload.batchCount) : null;

    const waves = buildWaves();
    const selected = waveId ? waves.filter((w) => w.id === waveId) : waves;
    const allResults = [];

    for (const wave of selected) {
      const start = Math.max(1, batchStart);
      const end = batchCount ? Math.min(start + batchCount - 1, wave.count) : wave.count;

      const jobs = [];
      for (let i = start; i <= end; i += 1) {
        jobs.push(runBot(baseUrl, wave, i, bypassHeader));
      }

      const settled = await Promise.allSettled(jobs);
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          allResults.push(item.value);
        }
      }

      await sleep(450);
    }

    const totalBots = allResults.length;
    const totalBlocked = allResults.filter((r) => r.blocked).length;
    const failures = allResults.filter((r) => r.FAILURE);
    const falsePos = allResults.filter((r) => r.FALSE_POS);
    const netErrors = allResults.filter((r) => r.status === 0).length;

    const waveBreakdown = selected.map((wave) => {
      const wr = allResults.filter((r) => r.wave === wave.id);
      const blocked = wr.filter((r) => r.blocked).length;
      const passed = wr.filter((r) => !r.blocked && r.status !== 0).length;
      const networkErrors = wr.filter((r) => r.status === 0).length;
      return {
        id: wave.id,
        name: wave.name,
        note: wave.note,
        count: wave.count,
        expectBlock: false,
        blocked,
        slipped: 0,
        falsePosCount: blocked,
        passed,
        networkErrors,
      };
    });

    const report = {
      generatedAt: new Date().toISOString(),
      runFromColo: request.cf?.colo || 'unknown',
      runFromCountry: request.cf?.country || 'unknown',
      target: baseUrl,
      waveId: waveId || 'ALL',
      batchStart,
      batchCount: batchCount || 'all',
      totalBots,
      totalBlocked,
      blockRate: totalBots > 0 ? `${((totalBlocked / totalBots) * 100).toFixed(1)}%` : '0.0%',
      failures: failures.length,
      falsePositives: falsePos.length,
      networkErrors: netErrors,
      verdict: 'LEGIT SESSION TEST COMPLETE',
      falsePositiveVerdict: falsePos.length === 0
        ? 'No collateral damage - legit requests unaffected.'
        : `WARNING: ${falsePos.length} legitimate request(s) were incorrectly blocked.`,
      waveBreakdown,
      rawResults: allResults,
      failureDetails: failures,
      falsePosDetails: falsePos,
    };

    return new Response(JSON.stringify(report, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

