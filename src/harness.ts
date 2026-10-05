import { evaluateRequest } from './evaluate';
import { loadConfigFromEnv } from './config';
import { MemoryStore } from './store';
import type { EvaluationInput } from './types';

export interface LabeledCase {
  label: 'good' | 'bad';
  name: string;
  input: EvaluationInput;
}

export function defaultCases(): LabeledCase[] {
  const browser = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    accept: 'text/html,application/json',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    host: 'localhost',
  };

  return [
    {
      label: 'good',
      name: 'browser-login',
      input: { method: 'POST', path: '/login', headers: browser, body: { email: 'a@example.com' }, ip: '203.0.113.10' },
    },
    {
      label: 'good',
      name: 'googlebot',
      input: {
        method: 'GET',
        path: '/',
        headers: { ...browser, 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
        body: {},
        ip: '203.0.113.20',
      },
    },
    {
      label: 'bad',
      name: 'curl-login',
      input: {
        method: 'POST',
        path: '/login',
        headers: { 'user-agent': 'curl/8.0.0', host: 'localhost' },
        body: { email: 'a@example.com' },
        ip: '198.51.100.10',
      },
    },
    {
      label: 'bad',
      name: 'headless',
      input: {
        method: 'POST',
        path: '/login',
        headers: { ...browser, 'user-agent': 'Mozilla/5.0 HeadlessChrome/124.0.0.0' },
        body: {},
        ip: '198.51.100.11',
      },
    },
    {
      label: 'bad',
      name: 'honeypot',
      input: {
        method: 'POST',
        path: '/register',
        headers: browser,
        body: { email: 'a@example.com', website: 'http://spam.example' },
        ip: '198.51.100.12',
      },
    },
    {
      label: 'bad',
      name: 'nonce-replay',
      input: {
        method: 'POST',
        path: '/login',
        headers: { ...browser, 'idempotency-key': 'reuse-me' },
        body: { email: 'a@example.com' },
        ip: '198.51.100.13',
      },
    },
  ];
}

export interface HarnessReport {
  total: number;
  good: number;
  bad: number;
  caught: number;
  falsePositives: number;
  catchRate: number;
  falsePositiveRate: number;
  details: Array<{ name: string; label: string; wouldHaveBlocked: boolean; wouldHaveChallenged: boolean; score: number }>;
}

export async function runHarness(cases: LabeledCase[] = defaultCases()): Promise<HarnessReport> {
  const config = loadConfigFromEnv({ FCGBDS_MODE: 'observe' } as NodeJS.ProcessEnv);
  const store = new MemoryStore();
  const details: HarnessReport['details'] = [];
  let caught = 0;
  let falsePositives = 0;
  let good = 0;
  let bad = 0;

  for (const testCase of cases) {
    if (testCase.label === 'good') good += 1;
    else bad += 1;
    const once = await evaluateRequest(testCase.input, config, store);
    let result = once;
    if (testCase.name === 'nonce-replay') {
      result = await evaluateRequest(testCase.input, config, store);
    }
    const flagged = result.wouldHaveBlocked || result.wouldHaveChallenged;
    if (testCase.label === 'bad' && flagged) caught += 1;
    if (testCase.label === 'good' && flagged) falsePositives += 1;
    details.push({
      name: testCase.name,
      label: testCase.label,
      wouldHaveBlocked: result.wouldHaveBlocked,
      wouldHaveChallenged: result.wouldHaveChallenged,
      score: result.score,
    });
  }

  return {
    total: cases.length,
    good,
    bad,
    caught,
    falsePositives,
    catchRate: bad === 0 ? 0 : caught / bad,
    falsePositiveRate: good === 0 ? 0 : falsePositives / good,
    details,
  };
}

async function cli(): Promise<void> {
  const report = await runHarness();
  console.log(JSON.stringify(report, null, 2));
  if (report.catchRate < 0.5) process.exitCode = 1;
}

if (require.main === module) {
  void cli();
}
