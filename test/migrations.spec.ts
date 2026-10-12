import { join } from 'node:path';
import { compareMigrations, loadMigrations, pendingMigrations } from '../src/database/migrations';

describe('迁移文件', () => {
  const dir = join(__dirname, '../database/migrations');

  it('按版本号与序号排序，而不是按字符串', () => {
    const names = ['V1.0.10-001-x.sql', 'V1.0.2-001-x.sql', 'V1.0.2-010-x.sql', 'V1.0.2-002-x.sql'];
    expect(names.sort(compareMigrations)).toEqual(['V1.0.2-001-x.sql', 'V1.0.2-002-x.sql', 'V1.0.2-010-x.sql', 'V1.0.10-001-x.sql']);
  });

  it('文件名不合规时报错', () => {
    expect(() => ['init.sql', 'V1.0.0-001-a.sql'].sort(compareMigrations)).toThrow('迁移文件名不合规');
  });

  it('只返回未执行的迁移', () => {
    const files = loadMigrations(dir);
    const applied = new Map([[files[0].version, files[0].checksum]]);
    expect(pendingMigrations(files, applied).map((f) => f.version)).toEqual(files.slice(1).map((f) => f.version));
  });

  it('已执行的文件被修改时拒绝继续', () => {
    const files = loadMigrations(dir);
    const applied = new Map([[files[0].version, 'changed']]);
    expect(() => pendingMigrations(files, applied)).toThrow('内容被修改');
  });

  it('仓库里的迁移文件都能被识别，且 001 建核心表', () => {
    const files = loadMigrations(dir);
    expect(files[0].version).toBe('V1.0.0-001-init.sql');
    for (const table of ['conversation', 'turn', 'msg_group', 'message', 'rp_param', 'handoff_record', 'flow_instance']) {
      expect(files[0].sql).toContain(`CREATE TABLE ${table} (`);
    }
  });
});
