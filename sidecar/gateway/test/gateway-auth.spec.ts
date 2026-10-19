import { GatewayAuthGuard } from '../src/auth/gateway-auth.guard';
import { UnauthorizedException } from '@nestjs/common';

describe('GatewayAuthGuard', () => {
  it('未配置 GATEWAY_AUTH_TOKEN 时应默认放行', () => {
    const guard = new GatewayAuthGuard({
      PORT: 3003,
      NODE_ENV: 'test',
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
      REDIS_DB: 0,
      REGISTRY_TTL_SECONDS: 30,
      IDENTITY_FETCH_TIMEOUT_MS: 300,
      IDENTITY_CACHE_TTL_SECONDS: 3600,
    });

    const mockContext: any = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {} }),
      }),
    };

    expect(guard.canActivate(mockContext)).toBe(true);
  });

  it('配置了 GATEWAY_AUTH_TOKEN 时，带正确 x-gateway-token 应放行', () => {
    const guard = new GatewayAuthGuard({
      PORT: 3003,
      NODE_ENV: 'test',
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
      REDIS_DB: 0,
      REGISTRY_TTL_SECONDS: 30,
      GATEWAY_AUTH_TOKEN: 'secret-token-123',
      IDENTITY_FETCH_TIMEOUT_MS: 300,
      IDENTITY_CACHE_TTL_SECONDS: 3600,
    });

    const mockContext: any = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-gateway-token': 'secret-token-123' },
        }),
      }),
    };

    expect(guard.canActivate(mockContext)).toBe(true);
  });

  it('配置了 GATEWAY_AUTH_TOKEN 时，带正确 Bearer Authorization 应放行', () => {
    const guard = new GatewayAuthGuard({
      PORT: 3003,
      NODE_ENV: 'test',
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
      REDIS_DB: 0,
      REGISTRY_TTL_SECONDS: 30,
      GATEWAY_AUTH_TOKEN: 'secret-token-123',
      IDENTITY_FETCH_TIMEOUT_MS: 300,
      IDENTITY_CACHE_TTL_SECONDS: 3600,
    });

    const mockContext: any = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer secret-token-123' },
        }),
      }),
    };

    expect(guard.canActivate(mockContext)).toBe(true);
  });

  it('配置了 GATEWAY_AUTH_TOKEN 时，Token 缺失或错误应抛出 UnauthorizedException', () => {
    const guard = new GatewayAuthGuard({
      PORT: 3003,
      NODE_ENV: 'test',
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
      REDIS_DB: 0,
      REGISTRY_TTL_SECONDS: 30,
      GATEWAY_AUTH_TOKEN: 'secret-token-123',
      IDENTITY_FETCH_TIMEOUT_MS: 300,
      IDENTITY_CACHE_TTL_SECONDS: 3600,
    });

    const mockNoToken: any = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {} }),
      }),
    };

    const mockWrongToken: any = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-gateway-token': 'wrong-token' },
        }),
      }),
    };

    expect(() => guard.canActivate(mockNoToken)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(mockWrongToken)).toThrow(UnauthorizedException);
  });
});
