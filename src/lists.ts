import type { ListEntry, ListKind, ListMatchType } from './types';

export function isListKind(value: string): value is ListKind {
  return value === 'allow' || value === 'deny';
}

export function isMatchType(value: string): value is ListMatchType {
  return value === 'ip' || value === 'cidr' || value === 'ua' || value === 'path' || value === 'header';
}

export function ipInCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;
  const [range, bitsStr] = cidr.split('/');
  const bits = Number.parseInt(bitsStr, 10);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(range) || !Number.isFinite(bits)) {
    return false;
  }
  const toInt = (v: string) => v.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(range) & mask);
}

export function matchList(
  entries: ListEntry[],
  subject: { ip: string; userAgent: string; path: string; headers?: Record<string, string | string[] | undefined> },
): ListEntry | undefined {
  for (const entry of entries) {
    if (entry.matchType === 'ip' && entry.value === subject.ip) return entry;
    if (entry.matchType === 'cidr' && ipInCidr(subject.ip, entry.value)) return entry;
    if (entry.matchType === 'ua' && subject.userAgent.toLowerCase().includes(entry.value.toLowerCase())) return entry;
    if (entry.matchType === 'path' && (subject.path === entry.value || subject.path.startsWith(entry.value))) return entry;
    if (entry.matchType === 'header' && subject.headers) {
      const split = entry.value.indexOf(':');
      if (split < 1) continue;
      const name = entry.value.slice(0, split).toLowerCase();
      const expect = entry.value.slice(split + 1);
      const raw = subject.headers[name];
      const got = Array.isArray(raw) ? raw.join(',') : String(raw || '');
      if (expect && got.includes(expect)) return entry;
    }
  }
  return undefined;
}
