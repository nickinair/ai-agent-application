/**
 * 管理账号命令行（§11.4；V1.0 没有账号管理页面）：
 *   ADMIN_PASSWORD='...' node dist/cli/admin.js create --tenant-code acme --username ops01 --role operator [--name 王五]
 *   ADMIN_PASSWORD='...' node dist/cli/admin.js reset-password --tenant-code acme --username ops01
 *   node dist/cli/admin.js disable --tenant-code acme --username ops01
 *   node dist/cli/admin.js list --tenant-code acme
 * 平台管理员：--tenant-code platform --role platform_admin。密码只从环境变量 ADMIN_PASSWORD 读，不出现在命令行参数和日志里。
 */
import 'reflect-metadata';
import { hashPassword, PLATFORM_TENANT_CODE } from '../auth/auth.service';
import { loadEnv } from '../config/env';
import { MysqlService } from '../database/mysql.service';

const ROLES = ['platform_admin', 'tenant_admin', 'operator', 'labeler'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function need(name: string): string {
  const v = arg(name);
  if (!v) throw new Error(`缺少参数 --${name}`);
  return v;
}

/** 密码强度：至少 10 位，含字母和数字 */
export function checkPassword(p: string | undefined): string {
  if (!p) throw new Error('请用环境变量 ADMIN_PASSWORD 提供密码');
  if (p.length < 10 || !/[A-Za-z]/.test(p) || !/\d/.test(p)) throw new Error('密码至少 10 位，且同时包含字母和数字');
  return p;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const mysql = new MysqlService(loadEnv());
  try {
    const code = need('tenant-code');
    const tenantId = code === PLATFORM_TENANT_CODE ? 0 : (await mysql.query<{ id: number }>('SELECT id FROM tenant WHERE code = ?', [code]))[0]?.id;
    if (tenantId === undefined) throw new Error(`没有租户 ${code}`);
    if (cmd === 'create') {
      const role = need('role');
      if (!ROLES.includes(role)) throw new Error(`角色须为 ${ROLES.join(' / ')}`);
      if ((role === 'platform_admin') !== (Number(tenantId) === 0)) throw new Error('平台管理员只能建在 platform 下，租户下不能建平台管理员');
      const hash = await hashPassword(checkPassword(process.env.ADMIN_PASSWORD));
      await mysql.execute('INSERT INTO admin_account (tenant_id, username, password_hash, real_name, role) VALUES (?, ?, ?, ?, ?)', [tenantId, need('username'), hash, arg('name') ?? null, role]);
      console.log(`已创建账号 ${code}/${arg('username')}（${role}）`);
    } else if (cmd === 'reset-password') {
      const hash = await hashPassword(checkPassword(process.env.ADMIN_PASSWORD));
      const r = await mysql.execute('UPDATE admin_account SET password_hash = ? WHERE tenant_id = ? AND username = ?', [hash, tenantId, need('username')]);
      console.log(r.affectedRows ? '密码已重置' : '账号不存在');
    } else if (cmd === 'disable') {
      const r = await mysql.execute('UPDATE admin_account SET status = 0 WHERE tenant_id = ? AND username = ?', [tenantId, need('username')]);
      console.log(r.affectedRows ? '账号已停用（已签发的令牌最长在有效期内仍可用）' : '账号不存在');
    } else if (cmd === 'list') {
      for (const a of await mysql.query<{ username: string; role: string; status: number; real_name: string | null }>('SELECT username, role, status, real_name FROM admin_account WHERE tenant_id = ? ORDER BY id', [tenantId])) {
        console.log(`${a.username}\t${a.role}\t${a.real_name ?? ''}${Number(a.status) ? '' : '\t（已停用）'}`);
      }
    } else {
      console.log('用法见文件头注释：create | reset-password | disable | list');
      process.exitCode = 2;
    }
  } finally {
    await mysql.onModuleDestroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
