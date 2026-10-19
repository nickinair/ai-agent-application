import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ENV, type Env } from '../config/env';

/**
 * 网关接口轻量鉴权守卫
 * 当环境变量配置了 GATEWAY_AUTH_TOKEN 时，校验请求头 x-gateway-token 或 Bearer Token；
 * 未配置时默认放行，支持本地与开发零摩擦。
 */
@Injectable()
export class GatewayAuthGuard implements CanActivate {
  constructor(@Optional() @Inject(ENV) private readonly env?: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredToken = this.env?.GATEWAY_AUTH_TOKEN;
    if (!requiredToken) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const tokenHeader = request.headers?.['x-gateway-token'];
    const authHeader = request.headers?.['authorization'];

    let providedToken = tokenHeader;
    if (!providedToken && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice(7).trim();
    }

    if (!providedToken || providedToken !== requiredToken) {
      throw new UnauthorizedException('无效或未提供 GATEWAY_AUTH_TOKEN 鉴权凭证');
    }

    return true;
  }
}
