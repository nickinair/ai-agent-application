import { checkPassword } from '../src/cli/admin';
import { assertApiSecrets, loadEnv } from '../src/config/env';
import { signToken, verifyToken } from '../src/auth/jwt';
import { LoginLimiter } from '../src/auth/login-limiter';

describe('鉴权', () => {
  const user = { sub: 1, tenantId: 3, username: 'ops', role: 'operator' as const };

  it('令牌：签发后可校验；密钥不对、过期、算法为 none 的都拒绝', () => {
    const token = signToken(user, 's'.repeat(32), 60);
    expect(verifyToken(token, 's'.repeat(32))).toEqual(user);
    expect(verifyToken(token, 'x'.repeat(32))).toBeNull();
    expect(verifyToken(signToken(user, 's'.repeat(32), -1), 's'.repeat(32))).toBeNull();
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...user, iss: 'agent-app' })).toString('base64url')}.`;
    expect(verifyToken(none, 's'.repeat(32))).toBeNull();
  });

  it('登录失败 5 次锁定 10 分钟，成功后清零', () => {
    let now = 0;
    const l = new LoginLimiter(5, 600_000, () => now);
    for (let i = 0; i < 4; i++) l.fail('u', 'ip');
    expect(l.lockedFor('u')).toBe(0);
    l.fail('u', 'ip');
    expect(l.lockedFor('u', 'other')).toBe(600_000);
    now = 600_001;
    expect(l.lockedFor('u')).toBe(0);
    l.fail('u');
    l.succeed('u');
    expect(l.lockedFor('u')).toBe(0);
  });

  it('生产环境必须配置足够长的 JWT 密钥；账号密码强度', () => {
    expect(() => assertApiSecrets(loadEnv({ NODE_ENV: 'production' }))).toThrow('JWT_SECRET');
    expect(() => assertApiSecrets(loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'k'.repeat(40) }))).not.toThrow();
    expect(loadEnv({ NODE_ENV: 'production' }).MYSQL_URL).toBeDefined(); // 迁移不受影响
    expect(() => checkPassword('short1')).toThrow('至少 10 位');
    expect(() => checkPassword('onlyletterssss')).toThrow();
    expect(checkPassword('Agent2026pass')).toBe('Agent2026pass');
  });
});
