import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export type AdminRole = 'platform_admin' | 'tenant_admin' | 'operator' | 'labeler';

/** 登录令牌里的身份。tenantId = 0 为平台管理员 */
export interface TokenClaims {
  sub: number;
  tenantId: number;
  username: string;
  role: AdminRole;
}

/** 本次请求操作的租户：普通账号固定为自己的租户；平台管理员用 ?tenantId= 指定 */
export interface TenantContext {
  tenantId: number;
  user: TokenClaims;
}

export const IS_PUBLIC = 'isPublic';
/** 不需要登录的接口（登录、健康检查） */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
/** 写操作限定角色；不标注的接口所有已登录账号可用（只读） */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES, roles);

export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantContext => ctx.switchToHttp().getRequest().tenant);
