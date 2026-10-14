import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { ENV, Env, jwtSecret } from '../config/env';
import { MysqlService } from '../database/mysql.service';
import { signToken } from './jwt';
import { LoginLimiter } from './login-limiter';
import type { AdminRole, TokenClaims } from './tenant-context';

/** 平台管理员登录时租户编码填 platform（tenant_id = 0） */
export const PLATFORM_TENANT_CODE = 'platform';

/** 用户名不存在时也做一次 bcrypt 比较，避免按响应时间猜账号 */
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

@Injectable()
export class AuthService {
  readonly limiter = new LoginLimiter();

  constructor(
    private readonly mysql: MysqlService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async login(tenantCode: string, username: string, password: string, ip: string): Promise<{ token: string; expiresIn: number; user: TokenClaims }> {
    const keys = [`u:${tenantCode}:${username}`, `ip:${ip}`];
    const locked = this.limiter.lockedFor(...keys);
    if (locked > 0) throw new HttpException(`登录失败次数过多，请 ${Math.ceil(locked / 60_000)} 分钟后再试`, HttpStatus.TOO_MANY_REQUESTS);

    const tenantId = tenantCode === PLATFORM_TENANT_CODE ? 0 : (await this.mysql.query<{ id: number }>('SELECT id FROM tenant WHERE code = ? AND status = 1', [tenantCode]))[0]?.id;
    const [acc] = tenantId === undefined ? [] : await this.mysql.query<{ id: number; password_hash: string; role: AdminRole }>(
      'SELECT id, password_hash, role FROM admin_account WHERE tenant_id = ? AND username = ? AND status = 1', [tenantId, username]);
    const ok = await bcrypt.compare(password, acc?.password_hash ?? DUMMY_HASH);
    // 平台管理员只能挂在租户 0 下；租户账号不能是平台管理员
    if (!acc || !ok || (acc.role === 'platform_admin') !== (Number(tenantId) === 0)) {
      this.limiter.fail(...keys);
      throw new UnauthorizedException('租户、账号或密码不正确');
    }
    this.limiter.succeed(...keys);
    const user: TokenClaims = { sub: Number(acc.id), tenantId: Number(tenantId), username, role: acc.role };
    const ttl = this.env.JWT_TTL_SECONDS ?? 8 * 3600;
    return { token: signToken(user, jwtSecret(this.env), ttl), expiresIn: ttl, user };
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}
