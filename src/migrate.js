import fs from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { config, assertProductionConfig } from './config.js';
import { pool } from './db.js';

assertProductionConfig();

await pool.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const migrationsDir = new URL('../db/', import.meta.url);
const migrations = (await fs.readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
for (const name of migrations) {
  const applied = await pool.query('SELECT name FROM schema_migrations WHERE name = $1', [name]);
  if (applied.rows[0]) continue;
  const sql = await fs.readFile(new URL(name, migrationsDir), 'utf8');
  const escapedName = name.replaceAll("'", "''");
  await pool.exec(`BEGIN IMMEDIATE;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${escapedName}');\nCOMMIT;`);
}

const passwordHash = await bcrypt.hash(config.adminPassword, 12);
await pool.query(
  `INSERT INTO users (email, password_hash, display_name, role)
   VALUES ($1, $2, '系统管理员', 'admin')
   ON CONFLICT (email) DO NOTHING`,
  [config.adminAccount, passwordHash],
);

console.log('数据库迁移完成');
await pool.end();
