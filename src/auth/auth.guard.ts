import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ENV, Env, jwtSecret } from '../config/env';
import { verifyToken } from './jwt';
import { AdminRole, IS_PUBLIC, ROLES, TenantContext } from './tenant-context';

/**
 * 全局鉴权（§11.4）：Bearer JWT → 解析身份与操作租户 → 角色校验。
 * 平台管理员必须用 ?tenantId= 指明操作哪个租户；其他账号传了别的 tenantId 一律拒绝。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header = String(req.headers.authorization ?? '');
    const user = header.startsWith('Bearer ') ? verifyToken(header.slice(7), jwtSecret(this.env)) : null;
    if (!user) throw new UnauthorizedException('请先登录');

    const asked = req.query?.tenantId === undefined ? undefined : Number(req.query.tenantId);
    let tenantId = user.tenantId;
    if (user.role === 'platform_admin') {
      if (asked === undefined || !Number.isInteger(asked) || asked <= 0) throw new ForbiddenException('平台管理员请用 ?tenantId= 指定要操作的租户');
      tenantId = asked;
    } else if (asked !== undefined && asked !== user.tenantId) {
      throw new ForbiddenException('不能操作其他租户的数据');
    }

    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES, targets);
    if (roles && !roles.includes(user.role)) throw new ForbiddenException('当前账号没有这个操作的权限');
    req.tenant = { tenantId, user } satisfies TenantContext;
    return true;
  }
}
