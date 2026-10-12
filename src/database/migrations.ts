import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}

/** 文件名形如 V1.0.0-001-init.sql；按版本号与序号排序（不是按字符串），保证执行顺序稳定。 */
const NAME = /^V(\d+)\.(\d+)\.(\d+)-(\d{3})-[\w-]+\.sql$/;

export function sortKey(name: string): number[] {
  const m = NAME.exec(name);
  if (!m) throw new Error(`迁移文件名不合规：${name}（应为 V1.0.0-001-描述.sql）`);
  return m.slice(1).map(Number);
}

export function compareMigrations(a: string, b: string): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

export function loadMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort(compareMigrations)
    .map((version) => {
      const sql = readFileSync(join(dir, version), 'utf8');
      return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * 计算待执行的迁移；已执行文件的内容被改过时直接报错（MySQL DDL 不能回滚，改历史文件会让各环境结构不一致）。
 */
export function pendingMigrations(files: MigrationFile[], applied: Map<string, string>): MigrationFile[] {
  for (const f of files) {
    const old = applied.get(f.version);
    if (old && old !== f.checksum) throw new Error(`迁移文件 ${f.version} 已执行过但内容被修改，请新增迁移文件`);
  }
  return files.filter((f) => !applied.has(f.version));
}
