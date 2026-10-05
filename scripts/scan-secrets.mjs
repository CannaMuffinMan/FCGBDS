import fs from 'fs';
import path from 'path';

const banned = [
  /forevercouch/i,
  /fcgcpa/i,
  /sk_live_/,
  /AKIA[0-9A-Z]{16}/,
  /twitch\.tv/i,
  /kick\.com/i,
];

const skip = new Set(['node_modules', 'dist', '.git']);

function walk(dir, hits) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, hits);
    else if (entry.isFile()) {
      if (entry.name === 'scan-secrets.mjs') continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const pattern of banned) {
        if (pattern.test(text)) hits.push(`${full}: ${pattern}`);
      }
    }
  }
}

const hits = [];
walk(process.cwd(), hits);
if (hits.length) {
  console.error(hits.join('\n'));
  process.exit(1);
}
console.log('scan-secrets: no banned markers');
