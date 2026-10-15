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
 * 历史上被改过、已恢复原样的迁移文件：改动版执行过的库也认可（改动内容已由后续迁移以可重复执行的方式补上）。
 * V1.0.0-001：曾直接加 turn.void_reason 一列，已恢复原样，该列改由 V1.0.0-004 添加。
 */
export const EQUIVALENT_CHECKSUMS: Record<string, string[]> = {
  'V1.0.0-001-init.sql': ['20479bf595a4b419f0f1d9dc2a202931683002f13e21b94a2e26657627782236'],
};

/**
 * 计算待执行的迁移；已执行文件的内容被改过时直接报错（MySQL DDL 不能回滚，改历史文件会让各环境结构不一致）。
 */
export function pendingMigrations(files: MigrationFile[], applied: Map<string, string>): MigrationFile[] {
  for (const f of files) {
    const old = applied.get(f.version);
    if (old && old !== f.checksum && !EQUIVALENT_CHECKSUMS[f.version]?.includes(old)) {
      throw new Error(`迁移文件 ${f.version} 已执行过但内容被修改，请新增迁移文件`);
    }
  }
  return files.filter((f) => !applied.has(f.version));
}
