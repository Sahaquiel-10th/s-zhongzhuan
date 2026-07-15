import bcrypt from 'bcryptjs';
import { config, assertProductionConfig } from './config.js';
import { pool } from './db.js';

assertProductionConfig();

const passwordHash = await bcrypt.hash(config.adminPassword, 12);
const result = await pool.query(
  `UPDATE users
      SET password_hash = $2, active = true
    WHERE email = $1 AND role = 'admin'
    RETURNING id`,
  [config.adminEmail, passwordHash],
);

if (!result.rows[0]) {
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, role)
     VALUES ($1, $2, '系统管理员', 'admin')`,
    [config.adminEmail, passwordHash],
  );
}

console.log(`管理员密码已重置: ${config.adminEmail}`);
await pool.end();
