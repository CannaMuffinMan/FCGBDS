import fs from 'fs';
import path from 'path';
import type { DefenseStore, ListEntry, ListKind, StoreBackend, WindowCount } from './types';

interface Queryable {
  get(sql: string, params: unknown[]): Record<string, unknown> | undefined;
  all(sql: string, params: unknown[]): Record<string, unknown>[];
  run(sql: string, params: unknown[]): void;
  exec(sql: string): void;
  close(): void;
}

function migrationsDir(kind: 'sqlite' | 'postgres'): string {
  return path.join(process.cwd(), 'migrations', kind);
}

export function applySqlMigrations(db: { exec(sql: string): void }, kind: 'sqlite' | 'postgres'): void {
  const dir = migrationsDir(kind);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
}

class SqlStore implements DefenseStore {
  constructor(
    private db: Queryable,
    private backendName: StoreBackend,
  ) {}

  backend(): StoreBackend {
    return this.backendName;
  }

  async incrementWindow(bucket: string, key: string, windowMs: number, now: number): Promise<WindowCount> {
    const row = this.db.get('SELECT count, expires_at FROM fcgbds_counters WHERE bucket = ? AND key = ?', [bucket, key]);
    const expires = Number(row?.expires_at ?? 0);
    if (!row || expires <= now) {
      const next = now + windowMs;
      this.db.run(
        `INSERT INTO fcgbds_counters (bucket, key, count, expires_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(bucket, key) DO UPDATE SET count = 1, expires_at = excluded.expires_at`,
        [bucket, key, next],
      );
      return { count: 1, backend: this.backendName };
    }
    this.db.run('UPDATE fcgbds_counters SET count = count + 1 WHERE bucket = ? AND key = ?', [bucket, key]);
    return { count: Number(row.count) + 1, backend: this.backendName };
  }

  async seenOnce(bucket: string, key: string, ttlMs: number): Promise<{ first: boolean; backend: StoreBackend }> {
    const now = Date.now();
    const row = this.db.get('SELECT expires_at FROM fcgbds_seen WHERE bucket = ? AND key = ?', [bucket, key]);
    if (row && Number(row.expires_at) > now) {
      return { first: false, backend: this.backendName };
    }
    const expires = now + ttlMs;
    this.db.run(
      `INSERT INTO fcgbds_seen (bucket, key, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(bucket, key) DO UPDATE SET expires_at = excluded.expires_at`,
      [bucket, key, expires],
    );
    return { first: true, backend: this.backendName };
  }

  async list(kind: ListKind): Promise<ListEntry[]> {
    const rows = this.db.all(
      'SELECT id, kind, match_type, value, note FROM fcgbds_list_entries WHERE kind = ? ORDER BY created_at ASC',
      [kind],
    );
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind) as ListKind,
      matchType: String(row.match_type) as ListEntry['matchType'],
      value: String(row.value),
      note: row.note ? String(row.note) : undefined,
    }));
  }

  async putList(entry: ListEntry): Promise<void> {
    this.db.run('DELETE FROM fcgbds_list_entries WHERE id = ?', [entry.id]);
    this.db.run(
      'INSERT INTO fcgbds_list_entries (id, kind, match_type, value, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.id, entry.kind, entry.matchType, entry.value, entry.note ?? null, Date.now()],
    );
  }

  async deleteList(kind: ListKind, id: string): Promise<boolean> {
    const existing = this.db.get('SELECT id FROM fcgbds_list_entries WHERE kind = ? AND id = ?', [kind, id]);
    if (!existing) return false;
    this.db.run('DELETE FROM fcgbds_list_entries WHERE kind = ? AND id = ?', [kind, id]);
    return true;
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.get('SELECT value FROM fcgbds_meta WHERE key = ?', [key]);
    return row ? String(row.value) : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db.run(
      `INSERT INTO fcgbds_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function openSqlite(filePath: string): DefenseStore {
  // node:sqlite is available in Node 22. The import is required lazily so older Node fails clearly.
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        get(...params: unknown[]): Record<string, unknown> | undefined;
        all(...params: unknown[]): Record<string, unknown>[];
        run(...params: unknown[]): void;
      };
      close(): void;
    };
  };
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  const wrapper: Queryable = {
    exec(sql) {
      db.exec(sql);
    },
    get(sql, params) {
      return db.prepare(sql).get(...params);
    },
    all(sql, params) {
      return db.prepare(sql).all(...params);
    },
    run(sql, params) {
      db.prepare(sql).run(...params);
    },
    close() {
      db.close();
    },
  };
  applySqlMigrations(wrapper, 'sqlite');
  return new SqlStore(wrapper, 'sqlite');
}

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export async function openPostgres(connectionString: string): Promise<DefenseStore> {
  const { Pool } = require('pg') as { Pool: new (opts: { connectionString: string }) => PgPool };
  const pool = new Pool({ connectionString });
  const wrapper: Queryable = {
    exec(sql) {
      throw new Error(`exec is async-only for postgres: ${sql.slice(0, 20)}`);
    },
    get() {
      throw new Error('sync get is not used for postgres');
    },
    all() {
      throw new Error('sync all is not used for postgres');
    },
    run() {
      throw new Error('sync run is not used for postgres');
    },
    close() {
      void pool.end();
    },
  };
  const files = fs.readdirSync(migrationsDir('postgres')).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(fs.readFileSync(path.join(migrationsDir('postgres'), file), 'utf8'));
  }
  return new PostgresStore(pool, wrapper);
}

class PostgresStore implements DefenseStore {
  constructor(
    private pool: PgPool,
    private closer: Queryable,
  ) {}

  backend(): StoreBackend {
    return 'postgres';
  }

  private q(text: string, values: unknown[]) {
    let i = 0;
    const converted = text.replace(/\?/g, () => {
      i += 1;
      return `$${i}`;
    });
    return this.pool.query(converted, values);
  }

  async incrementWindow(bucket: string, key: string, windowMs: number, now: number): Promise<WindowCount> {
    const existing = await this.q('SELECT count, expires_at FROM fcgbds_counters WHERE bucket = ? AND key = ?', [bucket, key]);
    const row = existing.rows[0];
    const expires = Number(row?.expires_at ?? 0);
    if (!row || expires <= now) {
      await this.q(
        `INSERT INTO fcgbds_counters (bucket, key, count, expires_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (bucket, key) DO UPDATE SET count = 1, expires_at = EXCLUDED.expires_at`,
        [bucket, key, now + windowMs],
      );
      return { count: 1, backend: 'postgres' };
    }
    await this.q('UPDATE fcgbds_counters SET count = count + 1 WHERE bucket = ? AND key = ?', [bucket, key]);
    return { count: Number(row.count) + 1, backend: 'postgres' };
  }

  async seenOnce(bucket: string, key: string, ttlMs: number): Promise<{ first: boolean; backend: StoreBackend }> {
    const now = Date.now();
    const existing = await this.q('SELECT expires_at FROM fcgbds_seen WHERE bucket = ? AND key = ?', [bucket, key]);
    const row = existing.rows[0];
    if (row && Number(row.expires_at) > now) return { first: false, backend: 'postgres' };
    await this.q(
      `INSERT INTO fcgbds_seen (bucket, key, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (bucket, key) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [bucket, key, now + ttlMs],
    );
    return { first: true, backend: 'postgres' };
  }

  async list(kind: ListKind): Promise<ListEntry[]> {
    const result = await this.q(
      'SELECT id, kind, match_type, value, note FROM fcgbds_list_entries WHERE kind = ? ORDER BY created_at ASC',
      [kind],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      kind: row.kind as ListKind,
      matchType: row.match_type as ListEntry['matchType'],
      value: String(row.value),
      note: row.note ? String(row.note) : undefined,
    }));
  }

  async putList(entry: ListEntry): Promise<void> {
    await this.q('DELETE FROM fcgbds_list_entries WHERE id = ?', [entry.id]);
    await this.q(
      'INSERT INTO fcgbds_list_entries (id, kind, match_type, value, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.id, entry.kind, entry.matchType, entry.value, entry.note ?? null, Date.now()],
    );
  }

  async deleteList(kind: ListKind, id: string): Promise<boolean> {
    const result = await this.q('DELETE FROM fcgbds_list_entries WHERE kind = ? AND id = ?', [kind, id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getMeta(key: string): Promise<string | null> {
    const result = await this.q('SELECT value FROM fcgbds_meta WHERE key = ?', [key]);
    return result.rows[0] ? String(result.rows[0].value) : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.q(
      `INSERT INTO fcgbds_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }

  async close(): Promise<void> {
    this.closer.close();
  }
}
