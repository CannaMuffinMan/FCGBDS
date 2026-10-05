import http from 'http';
import https from 'https';
import type { IpReputationHook } from './types';

/**
 * Calls an HTTP endpoint the operator runs. FCGBDS does not ship a reputation database.
 * Expects JSON `{ "score": number, "detail"?: string }` where score is 0–100 before the local cap.
 */
export function httpReputationHook(url: string, timeoutMs = 400): IpReputationHook {
  return {
    lookup(ip: string) {
      return new Promise((resolve) => {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          resolve(null);
          return;
        }
        const body = JSON.stringify({ ip });
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request(
          parsed,
          {
            method: 'POST',
            timeout: timeoutMs,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => {
              try {
                const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { score?: number; detail?: string };
                if (typeof parsedBody.score !== 'number') {
                  resolve(null);
                  return;
                }
                resolve({ score: parsedBody.score, detail: parsedBody.detail });
              } catch {
                resolve(null);
              }
            });
          },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
        req.end(body);
      });
    },
  };
}
