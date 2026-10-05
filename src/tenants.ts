import crypto from 'crypto';
import type { DefenseStore, TenantApp } from './types';

const META = 'tenants';

export function hashAppKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function newAppKey(): string {
  return crypto.randomBytes(24).toString('hex');
}

export async function readTenants(store: DefenseStore): Promise<TenantApp[]> {
  const raw = await store.getMeta(META);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TenantApp[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeTenants(store: DefenseStore, tenants: TenantApp[]): Promise<void> {
  await store.setMeta(META, JSON.stringify(tenants));
}

export async function findTenant(store: DefenseStore, presentedKey: string): Promise<TenantApp | undefined> {
  if (!presentedKey) return undefined;
  const hash = hashAppKey(presentedKey);
  return (await readTenants(store)).find((app) => app.keyHash === hash);
}
