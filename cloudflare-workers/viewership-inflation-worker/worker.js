/**
 * FCG Viewership Inflation Defense Worker
 * Specialized probe for OAuth-bridge/session viewbot detection paths.
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

function getTrafficFilteredWaves(waves, trafficMode) {
  if (trafficMode === 'bad') return waves.filter((w) => w.expectBlock);
  if (trafficMode === 'good') return waves.filter((w) => !w.expectBlock);
  return waves;
}

function buildSwarmHeaders(swarmProfile, waveId) {
  if (!swarmProfile || typeof swarmProfile !== 'object') return {};
  return {
    'X-Swarm-Id': swarmProfile.swarmId || 'unspecified',
    'X-Swarm-Fingerprint': swarmProfile.sharedFingerprint || 'none',
    'X-Swarm-Wave': waveId,
    'X-Swarm-Pattern': swarmProfile.pattern || 'burst-plateau-decay',
    'X-Behavior-Partial-Challenge-Rate': String(swarmProfile.partialChallengeRate ?? 0.7),
  };
}

function hasLegitAuthContext(legitAuth) {
  if (!legitAuth || typeof legitAuth !== 'object') return false;
  return Boolean(legitAuth.authorization || legitAuth.cookie || legitAuth.csrfToken);
}

function applyLegitAuthHeaders(headers, legitAuth) {
  if (!legitAuth || typeof legitAuth !== 'object') return;
  if (legitAuth.authorization && !headers.Authorization) {
    headers.Authorization = legitAuth.authorization;
  }
  if (legitAuth.cookie && !headers.Cookie) {
    headers.Cookie = legitAuth.cookie;
  }
  if (legitAuth.csrfToken && !headers['X-CSRF-Token']) {
    headers['X-CSRF-Token'] = legitAuth.csrfToken;
  }
}

function buildWaves() {
  const normalUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const headlessUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeadlessChrome/124.0.0.0 Safari/537.36';
  const phantomUA = 'Mozilla/5.0 (compatible; PhantomJS/2.1.1; +http://phantomjs.org)';

  return [
    {
      id: 'G',
      name: 'Session Health Baseline',
      count: 20,
      sequential: true,
      delayMs: 150,
      expectBlock: false,
      note: 'Normal UA against session health endpoint. Blocked = false positive.',
      scenario: 'session-health',
      requiresLegitAuth: true,
      userAgent: normalUA,
      path: '/api/chat-bridge/session/health',
      method: 'GET',
    },
    {
      id: 'V',
      name: 'Headless Fast-Rejoin Pattern',
      count: 240,
      expectBlock: true,
      note: 'Two-step validate with same session token; second call uses HeadlessChrome to force high-confidence bot score.',
      scenario: 'validate-two-step',
      initUserAgent: normalUA,
      userAgent: headlessUA,
      path: '/api/chat-bridge/session/validate',
      method: 'POST',
    },
    {
      id: 'P',
      name: 'PhantomJS Fast-Rejoin Pattern',
      count: 240,
      expectBlock: true,
      note: 'Two-step validate with PhantomJS signature on second call; should be blocked as automated activity.',
      scenario: 'validate-two-step',
      initUserAgent: normalUA,
      userAgent: phantomUA,
      path: '/api/chat-bridge/session/validate',
      method: 'POST',
    },
  ];
}

function buildHeaders(wave, bypassHeader, swarmProfile, waveId, runId, ua) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': ua || wave.userAgent || '',
    'X-Test-Run-Id': runId,
  };
  if (wave.expectBlock) {
    headers['X-Bot-Test'] = 'true';
    Object.assign(headers, buildSwarmHeaders(swarmProfile, waveId));
  }
  if (bypassHeader) headers['X-FCG-Test-Token'] = bypassHeader;
  return headers;
}

async function runBot(baseUrl, wave, botIndex, bypassHeader, swarmProfile, legitAuth) {
  const runId = `viewership-inflation-worker-${wave.id}`;
  const sessionToken = `vi-${wave.id}-${botIndex}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    const jitterMin = Number(swarmProfile?.jitterMinMs || 0);
    const jitterMax = Number(swarmProfile?.jitterMaxMs || 0);
    if (jitterMax > 0 && jitterMax >= jitterMin) {
      const jitter = Math.floor(jitterMin + Math.random() * (jitterMax - jitterMin + 1));
      if (jitter > 0) await sleep(jitter);
    }

    const started = Date.now();

    if (wave.scenario === 'session-health') {
      const url = `${baseUrl}${wave.path}?session=${encodeURIComponent(sessionToken)}`;
      const headers = buildHeaders(wave, bypassHeader, swarmProfile, wave.id, runId, wave.userAgent);
      applyLegitAuthHeaders(headers, legitAuth);
      const resp = await fetch(url, { method: 'GET', headers });
      let responseJson = null;
      let blockCode = '';
      try {
        responseJson = await resp.clone().json();
        blockCode = responseJson?.code || '';
      } catch (_) {}

      const blocked = resp.status === 403 || resp.status === 429;
      return {
        wave: wave.id,
        waveName: wave.name,
        bot: botIndex,
        status: resp.status,
        blocked,
        blockCode,
        expectBlock: wave.expectBlock,
        FAILURE: !blocked && wave.expectBlock,
        FALSE_POS: blocked && !wave.expectBlock,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        chainLatencyMs: null,
        path: wave.path,
        bodySample: `session=${sessionToken}`,
        error: '',
      };
    }

    if (wave.scenario === 'validate-two-step') {
      const url = `${baseUrl}${wave.path}`;
      const initHeaders = buildHeaders(wave, bypassHeader, swarmProfile, wave.id, runId, wave.initUserAgent);
      const strikeHeaders = buildHeaders(wave, bypassHeader, swarmProfile, wave.id, runId, wave.userAgent);
      applyLegitAuthHeaders(initHeaders, legitAuth);
      applyLegitAuthHeaders(strikeHeaders, legitAuth);

      const payload = JSON.stringify({ sessionToken, action: 'chat_join' });

      const initResp = await fetch(url, {
        method: 'POST',
        headers: initHeaders,
        body: payload,
      });

      // Keep this short so duration/no-engagement checks contribute bot score.
      await sleep(120);

      const strikeResp = await fetch(url, {
        method: 'POST',
        headers: strikeHeaders,
        body: payload,
      });

      let responseJson = null;
      let blockCode = '';
      try {
        responseJson = await strikeResp.clone().json();
        blockCode = responseJson?.code || '';
      } catch (_) {}

      const blocked = strikeResp.status === 403 || strikeResp.status === 429;

      return {
        wave: wave.id,
        waveName: wave.name,
        bot: botIndex,
        status: strikeResp.status,
        blocked,
        blockCode,
        expectBlock: wave.expectBlock,
        FAILURE: !blocked && wave.expectBlock,
        FALSE_POS: blocked && !wave.expectBlock,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        chainLatencyMs: null,
        path: wave.path,
        bodySample: `{"sessionToken":"${sessionToken}","action":"chat_join"}`,
        initStatus: initResp.status,
        error: '',
      };
    }

    throw new Error(`Unknown scenario '${wave.scenario}'`);
  } catch (err) {
    return {
      wave: wave.id,
      waveName: wave.name,
      bot: botIndex,
      status: 0,
      blocked: false,
      blockCode: '',
      expectBlock: wave.expectBlock,
      FAILURE: wave.expectBlock,
      FALSE_POS: false,
      startedAt: new Date().toISOString(),
      durationMs: null,
      chainLatencyMs: null,
      path: wave.path,
      bodySample: '',
      error: String(err),
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

    const triggerKey = String(payload.triggerKey || '').trim();
    const runToken = String(payload.runToken || '').trim();
    const triggerKeyMatches = Boolean(env.TRIGGER_KEY) && triggerKey.length > 0 && triggerKey === env.TRIGGER_KEY;
    const runTokenMatches = Boolean(env.WAF_BYPASS_TOKEN) && runToken.length > 0 && runToken === env.WAF_BYPASS_TOKEN;

    if (!triggerKeyMatches && !runTokenMatches) {
      return new Response('Unauthorized', { status: 401 });
    }

    const baseUrl = resolveTargetBaseUrl(payload, env);
    assertAllowedTarget(baseUrl, env);
    const bypassHeader = env.WAF_BYPASS_TOKEN || '';
    const trafficMode = payload.trafficMode || 'all';
    const swarmProfile = payload.swarmProfile || null;
    const legitAuth = payload.legitAuth || null;
    const waves = buildWaves();

    const waveId = payload.waveId || null;
    const batchStart = payload.batchStart || 1;
    const batchCount = payload.batchCount || null;

    const initialWaves = waveId ? waves.filter((w) => w.id === waveId) : waves;
    const wavesToRun = getTrafficFilteredWaves(initialWaves, trafficMode).filter((wave) => {
      if (!wave.requiresLegitAuth) return true;
      return hasLegitAuthContext(legitAuth);
    });

    const allResults = [];

    for (const wave of wavesToRun) {
      const start = batchStart;
      const end = batchCount
        ? Math.min(start + batchCount - 1, wave.count)
        : wave.count;

      if (wave.sequential) {
        for (let i = start; i <= end; i++) {
          allResults.push(await runBot(baseUrl, wave, i, bypassHeader, swarmProfile, legitAuth));
          if (wave.delayMs > 0 && i < end) {
            await sleep(wave.delayMs);
          }
        }
      } else {
        const promises = [];
        for (let i = start; i <= end; i++) {
          promises.push(runBot(baseUrl, wave, i, bypassHeader, swarmProfile, legitAuth));
        }

        const settled = await Promise.allSettled(promises);
        for (const item of settled) {
          if (item.status === 'fulfilled') allResults.push(item.value);
        }
      }

      await sleep(500);
    }

    const totalBots = allResults.length;
    const totalBlocked = allResults.filter((r) => r.blocked).length;
    const failures = allResults.filter((r) => r.FAILURE);
    const falsePos = allResults.filter((r) => r.FALSE_POS);
    const netErrors = allResults.filter((r) => r.status === 0).length;

    const waveBreakdown = waves.map((wave) => {
      const wr = allResults.filter((r) => r.wave === wave.id);
      const codes = {};
      for (const r of wr) {
        const code = r.blockCode || 'none';
        codes[code] = (codes[code] || 0) + 1;
      }

      return {
        id: wave.id,
        name: wave.name,
        note: wave.note,
        count: wave.count,
        expectBlock: wave.expectBlock,
        blocked: wr.filter((r) => r.blocked).length,
        slipped: wr.filter((r) => r.FAILURE).length,
        falsePosCount: wr.filter((r) => r.FALSE_POS).length,
        passed: wr.filter((r) => !r.blocked && r.status !== 0).length,
        blockCodes: codes,
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
      verdict: failures.length === 0
        ? 'DEFENSE HELD - Zero hostile bots got through.'
        : `!!! DEFENSE FAILED - ${failures.length} bot(s) bypassed detection.`,
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

