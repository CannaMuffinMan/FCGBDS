/**
 * FCG Bot Defense — Platform Abuse & Engagement Farming Validation Worker
 *
 * Simulates bot patterns specifically targeting the platform interaction
 * and engagement endpoints: reward farming, fake-view loops, multi-account
 * coordination, cross-platform spam, and unauthenticated mass probing.
 * All of these should be caught by the bot defense middleware.
 *
 * Trigger: POST /run  { "triggerKey": "<TRIGGER_KEY env var>" }
 * Optional batching: add waveId, batchStart, batchCount to run a wave slice.
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

function extractChainLatency(json) {
  if (!json || typeof json !== 'object') return null;
  const candidates = [
    json.chainLatencyMs,
    json.blockchainWriteLatencyMs,
    json.blockchainLatencyMs,
    json.metrics && json.metrics.chainLatencyMs,
  ];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

function getTrafficFilteredWaves(waves, trafficMode) {
  if (trafficMode === 'bad' || trafficMode === 'hostile') return waves.filter((w) => w.expectBlock);
  if (trafficMode === 'good' || trafficMode === 'legit' || trafficMode === 'legit-auth') return waves.filter((w) => !w.expectBlock);
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

function applyLegitAuthHeaders(headers, wave, legitAuth) {
  if (wave.expectBlock || !legitAuth || typeof legitAuth !== 'object') return;
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

// ── Shared legit browser header baseline ─────────────────────
const legitBase = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Origin': 'https://PLACEHOLDER_WEB_ORIGIN',
  'Referer': 'https://PLACEHOLDER_WEB_ORIGIN/',
  'Content-Type': 'application/json',
};

// Platforms and interaction types for variance
const PLATFORMS   = ['twitch', 'youtube', 'kick'];
const INTERACT    = ['view', 'like', 'follow', 'clip', 'share'];
const FAKE_TOKENS = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImZha2UxMjMiLCJpYXQiOjE3MDA0MDAwMDB9.FAKESIG',
  'Bearer farmbot_token_not_real_aaaaaaaaaaaaaaaaaa',
  'Bearer ' + 'x'.repeat(64),
];

// ── Attack waves ─────────────────────────────────────────────
function buildWaves(base) {
  return [
    // ── P1: Unauthenticated Mass Interact Probe ───────────────
    {
      id: 'P1', name: 'Unauthenticated Mass Interact Probe', count: 80, expectBlock: true,
      note: 'No auth header. Bot defense should catch the burst before auth middleware can even reject it.',
      path: '/api/platform/interact', method: 'POST',
      headers: {
        'User-Agent': 'python-requests/2.31.0',
        'Content-Type': 'application/json',
        'Accept': '*/*',
      },
      body: (i) => JSON.stringify({
        contentId: `content-${i}`,
        platform: PLATFORMS[i % PLATFORMS.length],
        interactionType: INTERACT[i % INTERACT.length],
        platformContentId: `stream-${i}`,
      }),
    },

    // ── P2: Fake Auth Token Replay Farm ──────────────────────
    {
      id: 'P2', name: 'Fake Auth Token Replay Farm', count: 80, expectBlock: true,
      note: 'Sends forged/invalid Bearer tokens. High-frequency burst targeting the interact endpoint.',
      path: '/api/platform/interact', method: 'POST',
      headers: {
        ...legitBase,
        'Authorization': FAKE_TOKENS[0],
      },
      body: (i) => JSON.stringify({
        contentId: `c${i}`,
        platform: PLATFORMS[i % PLATFORMS.length],
        interactionType: 'view',
        platformContentId: `vid-${i}`,
        metadata: { watchTime: 30, quality: '1080p' },
      }),
    },

    // ── P3: Reward-Farming Loop (identical payload burst) ─────
    {
      id: 'P3', name: 'Reward Farming — Identical Payload Burst', count: 80, expectBlock: true,
      note: 'Same contentId/platform/interactionType repeated 80 times. Simulates a bot looping for reward points.',
      path: '/api/platform/interact', method: 'POST',
      headers: {
        'User-Agent': 'Go-http-client/2.0',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: (_i) => JSON.stringify({
        contentId: 'reward-farm-target-001',
        platform: 'twitch',
        interactionType: 'view',
        platformContentId: 'stream-12345',
        metadata: { watchTime: 60 },
      }),
    },

    // ── P4: Multi-Account Coordinate Attack (varied accounts) ─
    {
      id: 'P4', name: 'Multi-Account Coordinated Farming', count: 80, expectBlock: true,
      note: 'Different fake account IDs with rotating UAs — simulates a botnet farming the same content from "many users".',
      path: '/api/platform/interact', method: 'POST',
      headers: {}, // overridden per-request in body builder
      body: (i) => {
        const uas = [
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
          'python-requests/2.31.0',
          'Go-http-client/1.1',
          'curl/8.5.0',
        ];
        // We can't mutate headers per request in this structure,
        // but the identical IP + burst pattern is the signal here.
        return JSON.stringify({
          contentId: 'coord-farm-content-007',
          platform: 'youtube',
          interactionType: 'like',
          platformContentId: `yt-vid-${i % 5}`, // 5 target videos rotating
          metadata: { accountId: `farmaccount${i}`, ua: uas[i % uas.length] },
        });
      },
    },

    // ── P5: Cross-Platform Spam (shotgun targeting all platforms) ─
    {
      id: 'P5', name: 'Cross-Platform Spam Shotgun', count: 80, expectBlock: true,
      note: 'Rapidly hits all three platforms with all interaction types. Bot-like burst with no session consistency.',
      path: '/api/platform/interact', method: 'POST',
      headers: {
        'User-Agent': 'node-fetch/3.0',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: (i) => JSON.stringify({
        contentId: `cross-${i}`,
        platform: PLATFORMS[i % PLATFORMS.length],
        interactionType: INTERACT[i % INTERACT.length],
        platformContentId: `target-${i}`,
      }),
    },

    // ── P6: Malformed Payload Mass Probe ─────────────────────
    {
      id: 'P6', name: 'Malformed Payload Mass Probe', count: 80, expectBlock: true,
      note: 'Sends incomplete/invalid payloads at high frequency — fuzzing the endpoint for info leakage or crash paths.',
      path: '/api/platform/interact', method: 'POST',
      headers: {
        'User-Agent': 'python-requests/2.28.0',
        'Content-Type': 'application/json',
        'Accept': '*/*',
      },
      body: (i) => {
        const malformed = [
          JSON.stringify({}),
          JSON.stringify({ contentId: null }),
          JSON.stringify({ platform: '', interactionType: 'INVALID_TYPE' }),
          JSON.stringify({ contentId: 'x'.repeat(5000) }), // oversized field
          '{"contentId": "unclosed string',
          JSON.stringify({ __proto__: { admin: true }, contentId: 'x' }), // proto pollution attempt
        ];
        return malformed[i % malformed.length];
      },
    },

    // ── PF: Legit Baseline (control group) ───────────────────
    {
      id: 'PF', name: 'Legit Baseline (control)', count: 20, expectBlock: false,
      note: 'Full browser headers, unique spaced payloads. Blocked = false positive against platform endpoint.',
      path: '/api/platform/interact', method: 'POST',
      headers: { ...legitBase },
      body: (i) => JSON.stringify({
        contentId: `real-content-${i}`,
        platform: PLATFORMS[i % PLATFORMS.length],
        interactionType: 'view',
        platformContentId: `legit-stream-${i}`,
        metadata: { watchTime: 45 + i },
      }),
    },
  ];
}

// ── Run a single request ──────────────────────────────────────
async function runBot(baseUrl, wave, botIndex, bypassHeader, swarmProfile, legitAuth) {
  const url = `${baseUrl}${wave.path}`;
  const body = wave.body(botIndex);
  const headers = { ...wave.headers };
  applyLegitAuthHeaders(headers, wave, legitAuth);
  if (wave.expectBlock) {
    Object.assign(headers, buildSwarmHeaders(swarmProfile, wave.id));
  }
  if (bypassHeader) headers['X-FCG-Test-Token'] = bypassHeader;
  if (wave.expectBlock) {
    headers['X-Bot-Test'] = 'true';
  }
  headers['X-Test-Run-Id'] = `platform-abuse-worker-${wave.id}`;

  try {
    const jitterMin = Number(swarmProfile?.jitterMinMs || 0);
    const jitterMax = Number(swarmProfile?.jitterMaxMs || 0);
    if (jitterMax > 0 && jitterMax >= jitterMin) {
      const jitter = Math.floor(jitterMin + Math.random() * (jitterMax - jitterMin + 1));
      if (jitter > 0) await sleep(jitter);
    }

    const started = Date.now();
    const resp = await fetch(url, { method: wave.method, headers, body });
    const durationMs = Date.now() - started;
    let blockCode = '';
    let responseJson = null;
    try {
      responseJson = await resp.clone().json();
      blockCode = responseJson.code || '';
    } catch (_) {}
    const chainLatencyMs = extractChainLatency(responseJson);
    // 403 = bot defense block; 429 = rate limit; 401/404 = passed defense, hit auth/route layer (not a block failure for platform endpoint)
    const blocked = resp.status === 403 || resp.status === 429;
    // For platform waves, 401/404 means bot defense PASSED the request through (defense did not block)
    // That's a FAILURE for waves we expect to be blocked, but NOT for the legit wave.
    return {
      wave: wave.id, waveName: wave.name, bot: botIndex,
      status: resp.status, blocked, blockCode,
      expectBlock: wave.expectBlock,
      FAILURE: !blocked && wave.expectBlock,
      FALSE_POS: blocked && !wave.expectBlock,
      startedAt: new Date(started).toISOString(),
      durationMs,
      chainLatencyMs,
      path: wave.path,
      bodySample: body.slice(0, 80),
      error: '',
    };
  } catch (err) {
    return {
      wave: wave.id, waveName: wave.name, bot: botIndex,
      status: 0, blocked: false, blockCode: '',
      expectBlock: wave.expectBlock,
      FAILURE: wave.expectBlock,
      FALSE_POS: false,
      startedAt: new Date().toISOString(),
      durationMs: null,
      chainLatencyMs: null,
      path: wave.path,
      bodySample: body.slice(0, 80),
      error: String(err),
    };
  }
}

// ── Main handler ──────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, worker: 'platform-abuse-worker', colo: request.cf?.colo || 'unknown' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/waves') {
      const manifest = buildWaves('').map(w => ({
        id: w.id, name: w.name, count: w.count, expectBlock: w.expectBlock, note: w.note,
      }));
      return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname !== '/run' || request.method !== 'POST') {
      return new Response('POST /run to trigger test', { status: 405 });
    }

    let payload;
    try { payload = await request.json(); } catch (_) {
      return new Response('Invalid JSON body', { status: 400 });
    }
    if (!env.TRIGGER_KEY || payload.triggerKey !== env.TRIGGER_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    const BASE_URL = resolveTargetBaseUrl(payload, env);
    assertAllowedTarget(BASE_URL, env);
    const BYPASS_HEADER = env.WAF_BYPASS_TOKEN || '';
    const trafficMode = payload.trafficMode || 'all';
    const swarmProfile = payload.swarmProfile || null;
    const legitAuth = payload.legitAuth || null;
    const waves = buildWaves(BASE_URL);

    const waveId     = payload.waveId     || null;
    const batchStart = payload.batchStart || 1;
    const batchCount = payload.batchCount || null;
    const initialWaves = waveId ? waves.filter(w => w.id === waveId) : waves;
    const wavesToRun = getTrafficFilteredWaves(initialWaves, trafficMode);

    const allResults = [];

    for (const wave of wavesToRun) {
      const start = batchStart;
      const end   = batchCount
        ? Math.min(start + batchCount - 1, wave.count)
        : wave.count;

      const promises = [];
      for (let i = start; i <= end; i++) {
        promises.push(runBot(BASE_URL, wave, i, BYPASS_HEADER, swarmProfile, legitAuth));
      }
      const waveResults = await Promise.allSettled(promises);
      for (const r of waveResults) {
        if (r.status === 'fulfilled') allResults.push(r.value);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    const totalBots    = allResults.length;
    const totalBlocked = allResults.filter(r => r.blocked).length;
    const failures     = allResults.filter(r => r.FAILURE);
    const falsePos     = allResults.filter(r => r.FALSE_POS);

    const byWave = {};
    for (const r of allResults) {
      if (!byWave[r.wave]) byWave[r.wave] = { name: r.waveName, total: 0, blocked: 0, failures: 0, falsePosCount: 0 };
      byWave[r.wave].total++;
      if (r.blocked) byWave[r.wave].blocked++;
      if (r.FAILURE) byWave[r.wave].failures++;
      if (r.FALSE_POS) byWave[r.wave].falsePosCount++;
    }

    const report = {
      worker: 'platform-abuse-worker',
      summary: {
        totalBots,
        totalBlocked,
        blockRate: totalBots ? `${((totalBlocked / totalBots) * 100).toFixed(1)}%` : '0%',
        failures: failures.length,
        falsePositives: falsePos.length,
        PASS: failures.length === 0 && falsePos.length === 0,
      },
      byWave,
      rawResults: allResults,
      failureDetails: failures.slice(0, 20),
      falsePosDetails: falsePos.slice(0, 20),
    };

    return new Response(JSON.stringify(report, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

