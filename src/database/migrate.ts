import { join } from 'node:path';
import { createConnection } from 'mysql2/promise';
import { loadEnv } from '../config/env';
import { loadMigrations, pendingMigrations } from './migrations';

/** 按序执行 database/migrations 下的 SQL（§18.2）。用法：npm run migrate */
async function main() {
  const env = loadEnv();
  const conn = await createConnection({ uri: env.MYSQL_URL, multipleStatements: true });
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      version VARCHAR(64) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [rows] = await conn.query('SELECT version, checksum FROM schema_migration');
    const applied = new Map((rows as Array<{ version: string; checksum: string }>).map((r) => [r.version, r.checksum]));

    const files = loadMigrations(join(__dirname, '../../database/migrations'));
    const pending = pendingMigrations(files, applied);
    if (pending.length === 0) {
      console.log('没有待执行的迁移');
      return;
    }
    for (const m of pending) {
      console.log(`执行 ${m.version} …`);
      await conn.query(m.sql);
      await conn.query('INSERT INTO schema_migration (version, checksum) VALUES (?, ?)', [m.version, m.checksum]);
    }
    console.log(`完成，共执行 ${pending.length} 个迁移`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
