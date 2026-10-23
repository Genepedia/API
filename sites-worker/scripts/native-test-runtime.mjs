import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

export async function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const migration of (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(await readFile(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'));
  }
  let queue = Promise.resolve();
  const db = {
    sqlite,
    prepare(sql) {
      let args = [];
      const result = (statement, mode) => {
        const query = sqlite.prepare(sql);
        if (mode === 'run' && !/\bRETURNING\b/i.test(sql)) {
          const meta = query.run(...args);
          return { success: true, results: [], meta: { changes: Number(meta.changes), last_row_id: Number(meta.lastInsertRowid) } };
        }
        const rows = query.all(...args).map((row) => ({ ...row }));
        return { success: true, results: rows, meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n } };
      };
      const statement = {
        bind(...values) {
          if (values.length > 100) throw new Error('D1 bound parameter limit exceeded.');
          args = values.map((value) => value === undefined ? null : value);
          return statement;
        },
        async first(column) {
          const row = result(statement, 'all').results[0] || null;
          return column && row ? row[column] : row;
        },
        async all() { return result(statement, 'all'); },
        async run() { return result(statement, 'run'); },
        async raw() { return result(statement, 'all').results.map((row) => Object.values(row)); },
      };
      return statement;
    },
    async batch(statements) {
      const operation = queue.then(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = [];
          for (const statement of statements) result.push(await statement.run());
          sqlite.exec('COMMIT');
          return result;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
  return db;
}

export class MemoryBucket {
  objects = new Map();
  async put(key, value, options = {}) {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value instanceof ReadableStream
      ? Buffer.from(await new Response(value).arrayBuffer()) : Buffer.from(value);
    this.objects.set(key, { bytes, options });
    return { key, size: bytes.length, etag: createHash('md5').update(bytes).digest('hex') };
  }
  async get(key) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    const { bytes, options } = entry;
    const etag = createHash('md5').update(bytes).digest('hex');
    return {
      key, size: bytes.length, etag, httpEtag: `"${etag}"`,
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {},
      body: new Response(bytes).body,
      async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
      async text() { return bytes.toString('utf8'); },
      writeHttpMetadata(headers) {
        const meta = options.httpMetadata || {};
        if (meta.contentType) headers.set('Content-Type', meta.contentType);
        if (meta.cacheControl) headers.set('Cache-Control', meta.cacheControl);
      },
    };
  }
  async head(key) { return this.get(key); }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }
  async list({ prefix = '', cursor = '', limit = 1000 } = {}) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix) && key > cursor).sort();
    const page = keys.slice(0, limit);
    return { objects: page.map((key) => ({ key, size: this.objects.get(key).bytes.length })), truncated: keys.length > page.length, cursor: keys.length > page.length ? page.at(-1) : undefined };
  }
}
