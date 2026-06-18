/**
 * FCG Bot Defense — FCGBC Legit Auth Worker
 *
 * Uses the internal synthetic auth broker to lease short-lived sessions
 * for up to 10 .fcgbc-backed synthetic accounts, then executes legit traffic
 * waves with rotating identities.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let leasePool = [];
let leaseCursor = 0;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function assertAllowedTarget(baseUrl, env) {
  const allowed = (env.ALLOWED_TARGET_HOSTS || 'PLACEHOLDER_API_HOST,PLACEHOLDER_SECONDARY_API_HOST,bdscore.PLACEHOLDER_WEB_HOST')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (!allowed.includes(host)) {
    throw new Error(`TARGET_API host '${host}' is not allowed`);
  }
}

function getTrafficFilteredWaves(waves, trafficMode) {
  if (trafficMode === 'bad' || trafficMode === 'hostile' || trafficMode === 'hostile-auth') return waves.filter((w) => w.expectBlock);
  if (trafficMode === 'good' || trafficMode === 'legit' || trafficMode === 'legit-auth') return waves.filter((w) => !w.expectBlock);
  return waves;
}

function randomInt(min, max) {
  const lo = Math.floor(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function pickFrom(list, fallback = '') {
  if (!Array.isArray(list) || list.length === 0) return fallback;
  return list[randomInt(0, list.length - 1)];
}

function buildLegitRequestProfile(wave, botIndex) {
  const deviceProfiles = [
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      acceptLang: 'en-US,en;q=0.9',
      platform: 'Windows',
      secChUa: '"Chromium";v="125", "Google Chrome";v="125", "Not.A/Brand";v="24"',
    },
    {
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      acceptLang: 'en-US,en;q=0.8',
      platform: 'macOS',
      secChUa: '"Chromium";v="124", "Google Chrome";v="124", "Not.A/Brand";v="24"',
    },
    {
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      acceptLang: 'en-GB,en;q=0.8',
      platform: 'Linux',
      secChUa: '"Chromium";v="123", "Google Chrome";v="123", "Not.A/Brand";v="24"',
    },
  ];

  const picked = deviceProfiles[botIndex % deviceProfiles.length];
  const refererRoute = pickFrom(['/app', '/wallet', '/profile', '/dashboard'], '/app');
  const pauseMs = randomInt(120, 1400);
  const occasionalLongPause = Math.random() < 0.08 ? randomInt(1500, 4500) : 0;

  return {
    pathSuffix: `${wave.path.includes('?') ? '&' : '?'}view=${pickFrom(['overview', 'recent', 'default'], 'default')}&t=${Date.now()}-${randomInt(10, 99)}`,
    delayMs: pauseMs + occasionalLongPause,
    headers: {
      'User-Agent': picked.ua,
      'Accept-Language': picked.acceptLang,
      'sec-ch-ua': picked.secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${picked.platform}"`,
      Referer: `https://PLACEHOLDER_APP_ORIGIN${refererRoute}`,
      DNT: Math.random() < 0.65 ? '1' : '0',
    },
  };
}

function buildHostileRequestProfile(wave) {
  const botUas = [
    'python-requests/2.32.3',
    'curl/8.8.0',
    'Go-http-client/1.1',
    'Mozilla/5.0 (compatible; MassScanner/1.0; +https://example.invalid/bot)',
  ];

  const microBurst = Math.random() < 0.7;
  const delayMs = microBurst ? randomInt(5, 60) : randomInt(80, 220);

  return {
    pathSuffix: `${wave.path.includes('?') ? '&' : '?'}attack=1&nonce=${Date.now()}${randomInt(1000, 9999)}&pattern=${pickFrom(['spray', 'replay', 'farm'], 'spray')}`,
    delayMs,
    headers: {
      'User-Agent': pickFrom(botUas, 'python-requests/2.32.3'),
      'X-Automation-Intent': 'mass-replay',
      'X-Request-Burst': String(randomInt(120, 900)),
      'X-Forwarded-For': `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(0, 255)}`,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      Referer: pickFrom(['https://spam.invalid', 'https://farm.invalid', 'https://replay.invalid'], 'https://spam.invalid'),
    },
  };
}

function computeTargetDelayMs(targetRpm) {
  const parsed = Number(targetRpm || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const safeRpm = Math.max(1, Math.min(10000, Math.floor(parsed)));
  return Math.max(0, Math.floor(60000 / safeRpm));
}

function computeRequestBudget(payload, env) {
  const payloadBudget = Number(payload?.maxRequestsPerRun || 0);
  const envBudget = Number(env.MAX_REQUESTS_PER_RUN || 0);
  const raw = payloadBudget > 0 ? payloadBudget : (envBudget > 0 ? envBudget : 30);
  // Cloudflare Worker invocations have strict subrequest ceilings; reserve headroom for broker calls.
  return Math.max(1, Math.min(35, Math.floor(raw)));
}

function buildSwarmHeaders(swarmProfile, waveId) {
  if (!swarmProfile || typeof swarmProfile !== 'object') return {};
  return {
    'X-Swarm-Id': swarmProfile.swarmId || 'fcgbc-legit-auth',
    'X-Swarm-Fingerprint': swarmProfile.sharedFingerprint || 'fcgbc-legit-fingerprint',
    'X-Swarm-Wave': waveId,
    'X-Swarm-Pattern': swarmProfile.pattern || 'human-jitter',
  };
}

async function brokerRequest(baseUrl, env, path, body = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'railway-app synthetic-auth-broker/1.0',
    'x-fcg-synthetic-broker-key': env.BROKER_KEY || '',
  };

  if (env.WAF_BYPASS_TOKEN) {
    headers['X-FCG-Test-Token'] = env.WAF_BYPASS_TOKEN;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw: raw ? raw.slice(0, 220) : '' };
  }

  if (!response.ok) {
    throw new Error(`Broker ${path} failed (${response.status}): ${JSON.stringify(data).slice(0, 220)}`);
  }

  return data;
}

function leaseIsValid(lease) {
  if (!lease || !lease.expiresAt) return false;
  const msRemaining = new Date(lease.expiresAt).getTime() - Date.now();
  return msRemaining > 60 * 1000;
}

async function getLease(brokerApiBase, env, accountHint = null) {
  if (leasePool.length > 0) {
    const checked = leasePool.length;
    for (let i = 0; i < checked; i += 1) {
      const idx = (leaseCursor + i) % leasePool.length;
      const candidate = leasePool[idx];
      if (leaseIsValid(candidate)) {
        leaseCursor = (idx + 1) % leasePool.length;
        return candidate;
      }
    }
  }

  const leaseRes = await brokerRequest(brokerApiBase, env, '/lease', {
    accountHint,
    forceRefresh: true,
  });

  if (!leaseRes?.lease) {
    throw new Error('Broker did not return a lease');
  }

  return leaseRes.lease;
}

async function warmLeasePool(baseUrl, env, count = 10, forceRefresh = false) {
  const warm = await brokerRequest(baseUrl, env, '/warmup', {
    count,
    forceRefresh,
  });

  const freshPool = [];
  if (Array.isArray(warm.results)) {
    for (const result of warm.results) {
      if (!result?.ok) continue;
      const leaseRes = await brokerRequest(baseUrl, env, '/lease', {
        accountHint: result.id,
        forceRefresh: false,
      });
      if (leaseRes?.lease) {
        freshPool.push(leaseRes.lease);
      }
    }
  }

  if (freshPool.length > 0) {
    leasePool = freshPool;
    leaseCursor = 0;
  }

  return {
    requested: count,
    warmed: freshPool.length,
    ok: freshPool.length > 0,
  };
}

async function warmLeasePoolSafe(baseUrl, env, count = 10, forceRefresh = false) {
  try {
    const result = await warmLeasePool(baseUrl, env, count, forceRefresh);
    return { ...result, error: '' };
  } catch (error) {
    return {
      requested: count,
      warmed: 0,
      ok: false,
      error: error && error.message ? String(error.message) : String(error),
    };
  }
}

function buildWaves(base) {
  return [
    {
      id: 'LA1',
      name: 'Wallet Session Status Check',
      count: 80,
      expectBlock: false,
      note: 'Authenticated GET against wallet status endpoint with rotating synthetic accounts.',
      method: 'GET',
      path: '/api/wallet/status',
      body: null,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    },
    {
      id: 'LA2',
      name: 'Authenticated User Session Check',
      count: 80,
      expectBlock: false,
      note: 'Authenticated GET against auth user endpoint with rotation and timing jitter.',
      method: 'GET',
      path: '/api/auth/user',
      body: null,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    },
    {
      id: 'LA3',
      name: 'Session Health Baseline',
      count: 80,
      expectBlock: false,
      note: 'Authenticated GET against session health endpoint with synthetic account rotation.',
      method: 'GET',
      path: '/api/chat-bridge/session/health',
      body: null,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    },
    {
      id: 'HA1',
      name: 'Authenticated Replay Spray (wallet status)',
      count: 120,
      expectBlock: true,
      note: 'High-frequency replay against authenticated wallet status using hostile automation fingerprints.',
      method: 'GET',
      path: '/api/wallet/status',
      body: null,
      headers: {
        'Accept': 'application/json, text/plain, */*',
      },
    },
    {
      id: 'HA2',
      name: 'Authenticated Session Enumeration (auth user)',
      count: 120,
      expectBlock: true,
      note: 'Aggressive repeated probing of auth user endpoint with coordinated burst cadence.',
      method: 'GET',
      path: '/api/auth/user',
      body: null,
      headers: {
        'Accept': 'application/json, text/plain, */*',
      },
    },
    {
      id: 'HA3',
      name: 'Coordinated Session Hammer (health endpoint)',
      count: 120,
      expectBlock: true,
      note: 'Short-cycle distributed hammer pattern against session health path.',
      method: 'GET',
      path: '/api/chat-bridge/session/health',
      body: null,
      headers: {
        'Accept': 'application/json, text/plain, */*',
      },
    },
  ];
}

async function runBot(baseUrl, brokerApiBase, wave, botIndex, bypassHeader, swarmProfile, env) {
  let lease;
  try {
    lease = await getLease(brokerApiBase, env);
  } catch (error) {
    return {
      botIndex,
      wave: wave.id,
      accountId: null,
      accountLabel: null,
      method: wave.method,
      path: wave.path,
      status: 0,
      blocked: false,
      FAILURE: true,
      FALSE_POS: false,
      blockCode: null,
      latencyMs: 0,
      behaviorDelayMs: 0,
      error: error && error.message ? `lease_error: ${String(error.message)}` : `lease_error: ${String(error)}`,
    };
  }

  const behavior = wave.expectBlock
    ? buildHostileRequestProfile(wave)
    : buildLegitRequestProfile(wave, botIndex);

  const pathWithEntropy = `${wave.path}${behavior.pathSuffix || ''}`;

  const headers = {
    ...wave.headers,
    ...behavior.headers,
    ...buildSwarmHeaders(swarmProfile, wave.id),
    Authorization: lease.authorization,
    Cookie: lease.cookie,
    'X-Test-Run-Id': `fcgbc-legit-auth-${wave.id}-${botIndex}`,
  };

  if (bypassHeader) headers['X-FCG-Test-Token'] = bypassHeader;

  const url = `${baseUrl}${pathWithEntropy}`;
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: wave.method,
      headers,
      body: wave.body,
    });

    const latencyMs = Date.now() - startedAt;
    const status = response.status;

    const blocked = status === 403 || status === 429 || (wave.expectBlock && status === 401);
    const failure = wave.expectBlock ? !blocked : blocked;

    return {
      botIndex,
      wave: wave.id,
      accountId: lease.accountId || null,
      accountLabel: lease.accountLabel || null,
      method: wave.method,
      path: pathWithEntropy,
      status,
      blocked,
      FAILURE: failure,
      FALSE_POS: !wave.expectBlock && blocked,
      blockCode: blocked ? 'request_blocked' : null,
      latencyMs,
      behaviorDelayMs: behavior.delayMs,
      error: null,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {
      botIndex,
      wave: wave.id,
      accountId: lease.accountId || null,
      accountLabel: lease.accountLabel || null,
      method: wave.method,
      path: pathWithEntropy,
      status: 0,
      blocked: false,
      FAILURE: true,
      FALSE_POS: false,
      blockCode: null,
      latencyMs,
      behaviorDelayMs: behavior.delayMs,
      error: error?.message || 'network_error',
    };
  }
}

function summarize(results, waves, workerName, baseUrl) {
  const totalBots = results.length;
  const totalBlocked = results.filter((r) => r.blocked).length;
  const failures = results.filter((r) => r.FAILURE).length;
  const falsePositives = results.filter((r) => r.FALSE_POS).length;
  const networkErrors = results.filter((r) => r.status === 0).length;

  const waveBreakdown = waves.map((wave) => {
    const slice = results.filter((r) => r.wave === wave.id);
    const blocked = slice.filter((r) => r.blocked).length;
    const slipped = slice.filter((r) => r.FAILURE).length;
    const falsePosCount = slice.filter((r) => r.FALSE_POS).length;

    return {
      id: wave.id,
      name: wave.name,
      note: wave.note,
      count: slice.length,
      expectBlock: wave.expectBlock,
      blocked,
      slipped,
      falsePosCount,
      passed: slice.filter((r) => !r.blocked && !r.FAILURE).length,
      blockCodes: {
        request_blocked: blocked,
      },
    };
  });

  const blockRate = totalBots > 0 ? `${((totalBlocked / totalBots) * 100).toFixed(1)}%` : '0.0%';

  return {
    workerName,
    workerUrl: 'fcgbc-legit-auth-worker',
    generatedAt: new Date().toISOString(),
    runFromColo: 'unknown-colo',
    runFromCountry: 'unknown',
    target: baseUrl,
    waveId: 'ALL',
    batchStart: 1,
    batchCount: totalBots,
    totalBots,
    totalBlocked,
    blockRate,
    failures,
    falsePositives,
    networkErrors,
    verdict: failures === 0
      ? 'DEFENSE HELD — Expected outcomes observed across hostile and legit lanes.'
      : `DEFENSE SIGNAL — ${failures} request(s) deviated from expected lane behavior.`,
    falsePositiveVerdict: falsePositives === 0
      ? 'No collateral damage — legit requests unaffected.'
      : `WARNING: ${falsePositives} legitimate request(s) were incorrectly blocked.`,
    waveBreakdown,
    rawResults: results,
    failureDetails: results.filter((r) => r.FAILURE),
    falsePosDetails: results.filter((r) => r.FALSE_POS),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, worker: 'fcgbc-legit-auth-worker', colo: request.cf?.colo || 'unknown' });
    }

    if (url.pathname === '/waves') {
      const baseUrl = env.TARGET_API || 'https://PLACEHOLDER_API_BASE_URL';
      const waves = buildWaves(baseUrl);
      return json(waves);
    }

    if (url.pathname === '/bootstrap' && request.method === 'POST') {
      const payload = await request.json().catch(() => ({}));
      if ((payload.triggerKey || '') !== (env.TRIGGER_KEY || '')) {
        return new Response('Unauthorized', { status: 401 });
      }

      const brokerBase = (env.BROKER_BASE_URL || env.TARGET_API || 'https://PLACEHOLDER_API_BASE_URL').replace(/\/+$/, '');
      const count = Math.max(1, Math.min(Number(payload.count || 10), 20));

      try {
        const result = await warmLeasePoolSafe(`${brokerBase}/api/internal/synthetic-auth`, env, count, Boolean(payload.forceRefresh));
        return json({ ok: result.ok, ...result, poolSize: leasePool.length });
      } catch (error) {
        console.error('bootstrap warmup failed', {
          message: error?.message || String(error),
          brokerBase,
          count,
          forceRefresh: Boolean(payload.forceRefresh),
        });
        return json({ ok: false, error: error?.message || String(error) }, 500);
      }
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      const payload = await request.json().catch(() => ({}));
      if ((payload.triggerKey || '') !== (env.TRIGGER_KEY || '')) {
        return new Response('Unauthorized', { status: 401 });
      }

      const baseUrl = env.TARGET_API || 'https://PLACEHOLDER_API_BASE_URL';
      assertAllowedTarget(baseUrl, env);

      const brokerBase = (env.BROKER_BASE_URL || baseUrl).replace(/\/+$/, '');
      if (!env.BROKER_KEY) {
        return json({ error: 'BROKER_KEY is not configured' }, 500);
      }

      const trafficMode = String(payload.trafficMode || 'legit-auth').toLowerCase();
      const allWaves = buildWaves(baseUrl);
      const waves = getTrafficFilteredWaves(allWaves, trafficMode);
      const waveId = payload.waveId ? String(payload.waveId) : null;
      const filteredWaves = waveId ? waves.filter((w) => w.id === waveId) : waves;

      if (!filteredWaves.length) {
        return json({ error: `No waves match traffic mode '${trafficMode}' and waveId '${waveId || 'ALL'}'` }, 400);
      }

      const brokerApiBase = `${brokerBase}/api/internal/synthetic-auth`;

      if (leasePool.length === 0) {
        const warmResult = await warmLeasePoolSafe(brokerApiBase, env, 10, false);
        if (!warmResult.ok) {
          console.error('run warmup failed, continuing with on-demand lease', {
            requested: warmResult.requested,
            warmed: warmResult.warmed,
            error: warmResult.error,
          });
        }
      }

      const bypassHeader = env.WAF_BYPASS_TOKEN || '';
      const swarmProfile = payload.swarmProfile || null;
      const batchStart = Math.max(1, Number(payload.batchStart || 1));
      const batchCountRaw = Number(payload.batchCount || 0);
      const targetRpm = Number(payload.targetRpm || env.WORKER_TARGET_RPM || 10000);
      const targetDelayMs = computeTargetDelayMs(targetRpm);
      const maxRequestsPerRun = computeRequestBudget(payload, env);
      let remainingRequestBudget = maxRequestsPerRun;

      const results = [];

      for (const wave of filteredWaves) {
        const maxCount = Number(wave.count || 0);
        const first = Math.min(batchStart, maxCount);
        const cap = batchCountRaw > 0 ? Math.min(batchCountRaw, maxCount - first + 1) : (maxCount - first + 1);
        const last = Math.max(first, first + cap - 1);

        if (remainingRequestBudget <= 0) {
          break;
        }

        for (let i = first; i <= last; i += 1) {
          if (remainingRequestBudget <= 0) {
            break;
          }

          const result = await runBot(baseUrl, brokerApiBase, wave, i, bypassHeader, swarmProfile, env);
          results.push(result);
          remainingRequestBudget -= 1;

          const behaviorDelay = Number(result.behaviorDelayMs || (wave.expectBlock ? randomInt(20, 120) : randomInt(120, 1400)));
          const delay = targetDelayMs === null ? behaviorDelay : Math.min(behaviorDelay, targetDelayMs);
          await sleep(delay);
        }
      }

      const summary = summarize(results, filteredWaves, 'fcgbc-legit-auth-worker', baseUrl);
      summary.targetRpm = Number.isFinite(targetRpm) ? Math.max(1, Math.min(10000, Math.floor(targetRpm))) : null;
      summary.targetDelayMs = targetDelayMs;
      summary.maxRequestsPerRun = maxRequestsPerRun;
      summary.truncatedByRequestBudget = remainingRequestBudget === 0;
      return json(summary);
    }

    return new Response('Not found', { status: 404 });
  },
};

