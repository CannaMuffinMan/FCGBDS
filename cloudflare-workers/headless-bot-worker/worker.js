/**
 * FCG Bot Defense — scripted fetch() probe with automation-like headers.
 *
 * This worker does not launch Playwright, Puppeteer, Selenium, or headless Chrome.
 * It sends fetch() requests whose User-Agent and header sets resemble those tools.
 * A HeadlessChrome token in the UA is a string the gate may score, not a browser.
 * TODO: real Playwright (and Selenium) lanes that drive an actual browser.
 * See README "Cloudflare Workers for testing and simulation".
 *
 * Trigger: POST /run  { "triggerKey": "<TRIGGER_KEY env var>" }
 * Optional batching: add waveId, batchStart, batchCount to run a wave slice.
 */

import {
  stripHarnessLabels,
  resolveProtectedPaths,
  gradeObservation,
  logHarnessCorrelation,
  summarizeDefense,
} from '../harness/gateGrade.js';

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
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.202 Safari/537.36',
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

// ── Attack waves ─────────────────────────────────────────────
function buildWaves(base) {
  return [
    // ── H1: Old-style Headless Chrome UA ─────────────────────
    {
      id: 'H1', name: 'Old HeadlessChrome UA', count: 80, expectBlock: true,
      note: 'UA contains "HeadlessChrome" substring — the most obvious headless indicator. No Sec-Fetch headers.',
      path: '/api/auth/email/register', method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // intentionally missing all Sec-Fetch-*, Sec-Ch-Ua, Origin, Referer
      },
      body: (i) => JSON.stringify({ email: `headless${i}@bot.invalid`, password: `HeadlessPass${i}!`, username: `headless${i}` }),
    },

    // ── H2: Puppeteer Default Fingerprint ────────────────────
    {
      id: 'H2', name: 'Puppeteer Default UA', count: 80, expectBlock: true,
      note: 'Exact UA Puppeteer uses by default. Missing Referer, has wrong Sec-Fetch-Site for cross-site call.',
      path: '/api/auth/email/register', method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.201 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'none', // wrong — headless default
        'Content-Type': 'application/json',
        'Origin': 'https://PLACEHOLDER_WEB_ORIGIN',
        // no Sec-Ch-Ua, no Referer, no Accept-Encoding
      },
      body: (i) => JSON.stringify({ email: `puppy${i}@puppet.invalid`, password: `PuppetPass${i}!`, username: `puppybot${i}` }),
    },

    // ── H3: Playwright Chromium Default ──────────────────────
    {
      id: 'H3', name: 'Playwright Chromium UA', count: 80, expectBlock: true,
      note: 'Playwright Chromium UA pattern. Has Accept: */* (not browser default), missing Accept-Encoding.',
      path: '/api/auth/email/login', method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        // no Accept-Encoding, no Sec-Ch-Ua, no Referer, no Origin
      },
      body: (i) => {
        const domains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'live.com'];
        return JSON.stringify({ email: `playwright${i}@${domains[i % domains.length]}`, password: `PlayPass${i}!` });
      },
    },

    // ── H4: Selenium WebDriver UA ────────────────────────────
    {
      id: 'H4', name: 'Selenium WebDriver UA', count: 80, expectBlock: true,
      note: 'Selenium leaves "MSEDGE" or "Firefox" + "Selenium" or bare automation UA patterns. This uses the classic Selenium Chrome pattern.',
      path: '/api/auth/email/register', method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US',
        // Selenium-driven Chrome sets a `webdriver` flag. We can't set that in headers,
        // but we CAN mimic the malformed header pattern selenium leaves behind.
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Content-Type': 'application/json',
        // Missing all Sec-Fetch-*, Sec-Ch-Ua, Origin, Referer — Selenium doesn't add these
      },
      body: (i) => JSON.stringify({ email: `selbot${i}@selenium.invalid`, password: `SelPass${i}!`, username: `selbot${i}` }),
    },

    // ── H5: Modern Headless Evasion (Stealth Plugin Style) ───
    {
      id: 'H5', name: 'Stealth Plugin Evasion (near-legit)', count: 80, expectBlock: true,
      note: 'Mimics puppeteer-extra-plugin-stealth: full Chrome UA, correct Sec-Ch-Ua, but body is identical across requests and timing is machine-like (no variation).',
      path: '/api/auth/email/register', method: 'POST',
      headers: { ...legitBase },
      body: (_i) => JSON.stringify({
        // Identical body every time — no human variation
        email: 'stealthbot@test.invalid',
        password: 'StealthPass99!',
        username: 'stealthbot',
      }),
    },

    // ── H6: CDP Raw Fetch (no Origin, no Referer) ────────────
    {
      id: 'H6', name: 'CDP Raw fetch() — no Origin/Referer', count: 80, expectBlock: true,
      note: 'Simulates a browser DevTools console fetch() call — Chrome UA, correct Sec-Fetch-Mode but missing Origin and Referer (CDP context does not add them).',
      path: '/api/auth/email/login', method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site', // CDP context sets this incorrectly
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Content-Type': 'application/json',
        // no Origin, no Referer
      },
      body: (i) => {
        const domains = ['gmail.com', 'yahoo.com', 'proton.me'];
        return JSON.stringify({ email: `cdpuser${i}@${domains[i % domains.length]}`, password: `CdpPass${i}!` });
      },
    },

    // ── HF: Legit Baseline (control group) ───────────────────
    {
      id: 'HF', name: 'Legit Baseline (control)', count: 4, expectBlock: false,
      note: 'Full real-browser headers with per-run unique identity. Blocked = false positive.',
      path: '/api/auth/email/register', method: 'POST',
      headers: { ...legitBase },
      body: (i) => {
        const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        return JSON.stringify({
          email: `realheadless${i}-${nonce}@gmail.com`,
          password: `S3cur3${i}!Pass`,
          username: `realhuman${i}-${nonce}`,
        });
      },
    },
  ];
}

// ── Run a single request ──────────────────────────────────────
async function runBot(baseUrl, wave, botIndex, swarmProfile, legitAuth, protectedPaths) {
  const url = `${baseUrl}${wave.path}`;
  const body = wave.body(botIndex);
  const headers = stripHarnessLabels({ ...wave.headers });
  applyLegitAuthHeaders(headers, wave, legitAuth);
  // Swarm profile stays in the harness report. It is not copied onto the request.

  try {
    const jitterMin = Number(swarmProfile?.jitterMinMs || 0);
    const jitterMax = Number(swarmProfile?.jitterMaxMs || 0);
    if (jitterMax > 0 && jitterMax >= jitterMin) {
      const jitter = Math.floor(jitterMin + Math.random() * (jitterMax - jitterMin + 1));
      if (jitter > 0) await sleep(jitter);
    }

    const started = Date.now();
    logHarnessCorrelation({
      worker: 'headless-bot-worker',
      waveId: wave.id,
      expectBlock: wave.expectBlock,
      startedAt: new Date(started).toISOString(),
    });
    const resp = await fetch(url, { method: wave.method, headers, body });
    const durationMs = Date.now() - started;
    let responseJson = null;
    try {
      responseJson = await resp.clone().json();
    } catch (_) {}
    const chainLatencyMs = extractChainLatency(responseJson);
    const grade = gradeObservation({
      status: resp.status,
      body: responseJson,
      expectBlock: wave.expectBlock,
      path: wave.path,
      protectedPaths,
    });
    return {
      wave: wave.id, waveName: wave.name, bot: botIndex,
      ...grade,
      blockCode: grade.blockCode,
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
      ...gradeObservation({
        status: 0,
        body: null,
        expectBlock: wave.expectBlock,
        path: wave.path,
        protectedPaths,
      }),
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
      return new Response(JSON.stringify({ ok: true, worker: 'headless-bot-worker', colo: request.cf?.colo || 'unknown' }), {
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
    const protectedPaths = resolveProtectedPaths(payload, env);
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
        promises.push(runBot(BASE_URL, wave, i, swarmProfile, legitAuth, protectedPaths));
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

    const defense = summarizeDefense(allResults, wavesToRun);
    const report = {
      worker: 'headless-bot-worker',
      harness: 'fetch()-only. Not a headless browser. See README.',
      protectedPaths,
      summary: {
        totalBots,
        totalBlocked,
        blockRate: totalBots ? `${((totalBlocked / totalBots) * 100).toFixed(1)}%` : '0%',
        failures: defense.failures,
        falsePositives: defense.falsePositives,
        PASS: defense.failures === 0 && defense.falsePositives === 0,
        defenseOnly: true,
      },
      byWave,
      ...defense,
      rawResults: allResults,
      failureDetails: failures.filter((row) => row.claimedAsDefense).slice(0, 20),
      falsePosDetails: falsePos.filter((row) => row.claimedAsDefense).slice(0, 20),
    };

    return new Response(JSON.stringify(report, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

