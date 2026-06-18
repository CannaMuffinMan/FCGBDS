/**
 * FCG Bot Defense - Legit Browser Traffic Worker
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
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Origin': 'https://PLACEHOLDER_WEB_ORIGIN',
    'Referer': 'https://PLACEHOLDER_WEB_ORIGIN/',
    'Content-Type': 'application/json',
  };

  return [
    {
      id: 'LB1',
      name: 'Legit Browser Register Attempt',
      count: 100,
      expectBlock: false,
      note: 'Browser-like register requests with unique payload.',
      path: '/api/auth/email/register',
      method: 'POST',
      headers: browserHeaders,
      body: (i) => JSON.stringify({
        email: `legit.browser.${Date.now()}.${i}@example.com`,
        password: `LegitPass${i}!A`,
        username: `legitbrowser${i}${Math.floor(Math.random() * 10000)}`,
      }),
    },
    {
      id: 'LB2',
      name: 'Legit Browser Login Attempt',
      count: 100,
      expectBlock: false,
      note: 'Browser-like login attempts with unique credentials.',
      path: '/api/auth/email/login',
      method: 'POST',
      headers: browserHeaders,
      body: (i) => JSON.stringify({
        email: `existing.user.${i}@example.com`,
        password: `LegitLogin${i}!`,
      }),
    },
    {
      id: 'LB3',
      name: 'Legit Browser Health Poll',
      count: 100,
      expectBlock: false,
      note: 'Health endpoint read requests.',
      path: '/api/health',
      method: 'GET',
      headers: browserHeaders,
      body: () => '',
    },
    {
      id: 'LB4',
      name: 'Legit Browser Stats Poll',
      count: 100,
      expectBlock: false,
      note: 'Bot defense stats read requests.',
      path: '/api/bot-defense/stats',
      method: 'GET',
      headers: browserHeaders,
      body: () => '',
    },
    {
      id: 'LB5',
      name: 'Legit Browser Session Check',
      count: 100,
      expectBlock: false,
      note: 'Session/status checks from browser headers.',
      path: '/api/auth/user',
      method: 'GET',
      headers: browserHeaders,
      body: () => '',
    },
  ];
}

async function runBot(baseUrl, wave, botIndex, bypassHeader) {
  const url = `${baseUrl}${wave.path}`;
  const headers = {
    ...wave.headers,
    'X-Test-Run-Id': `legit-browser-${wave.id}`,
    'X-Legit-Traffic': 'true',
    'X-CSRF-Token': crypto.randomUUID().replace(/-/g, ''),
  };

  if (bypassHeader) {
    headers['X-FCG-Test-Token'] = bypassHeader;
  }

  const jitter = Math.floor(50 + Math.random() * 250);
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

      await sleep(300);
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
      verdict: 'LEGIT TRAFFIC TEST COMPLETE',
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

