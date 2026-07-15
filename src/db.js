import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

if (config.databasePath !== ':memory:') {
  fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
}

const database = new DatabaseSync(config.databasePath, {
  enableForeignKeyConstraints: true,
});

database.exec('PRAGMA journal_mode = WAL;');
database.exec('PRAGMA synchronous = NORMAL;');
database.exec('PRAGMA busy_timeout = 5000;');

let queue = Promise.resolve();

function normalizeParams(params) {
  return params.map((value) => typeof value === 'boolean' ? Number(value) : value);
}

function sqliteSql(text) {
  return text
    .replace(/\$(\d+)/g, '?$1')
    .replace(/\bnow\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\bGREATEST\s*\(/gi, 'MAX(')
    .replace(/\s+FOR\s+UPDATE\b/gi, '');
}

function directQuery(text, params = []) {
  const sql = sqliteSql(text).trim();
  const statement = database.prepare(sql);
  const values = normalizeParams(params);
  const returnsRows = /^SELECT\b/i.test(sql) || /^WITH\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  if (returnsRows) {
    const rows = statement.all(...values);
    return { rows, rowCount: rows.length };
  }
  const result = statement.run(...values);
  return { rows: [], rowCount: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
}

function withLock(work) {
  const previous = queue;
  let release;
  queue = new Promise((resolve) => { release = resolve; });
  return previous.then(work).finally(release);
}

const directClient = {
  query(text, params) {
    return Promise.resolve(directQuery(text, params));
  },
  release() {},
};

export const pool = {
  query(text, params = []) {
    return withLock(() => directQuery(text, params));
  },
  exec(text) {
    return withLock(() => database.exec(text));
  },
  connect() {
    return Promise.resolve(directClient);
  },
  end() {
    return withLock(() => database.close());
  },
};

export function transaction(work) {
  return withLock(async () => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await work(directClient);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}
