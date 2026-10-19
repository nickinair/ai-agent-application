import { DynamicModule, Module } from '@nestjs/common';
import { ENV, Env, loadEnv } from './config/env';
import { RedisService } from './infra/redis.service';
import { MemberIdentityService } from './identity/member-identity.service';
import { RegistryService } from './registry/registry.service';
import { RegistryController } from './registry/registry.controller';
import { ConfigService } from './config-center/config.service';
import { ConfigController } from './config-center/config.controller';
import { HealthController } from './health/health.controller';
import { GatewayAuthGuard } from './auth/gateway-auth.guard';
import { ManualModule } from './manual/manual.module';

@Module({})
export class AppModule {
  static forRoot(envOverride?: Partial<Env>): DynamicModule {
    const env = loadEnv(envOverride as Record<string, string | undefined>);

    return {
      module: AppModule,
      imports: [
        ManualModule,
      ],
      controllers: [
        HealthController,
        RegistryController,
        ConfigController,
      ],
      providers: [
        { provide: ENV, useValue: env },
        RedisService,
        MemberIdentityService,
        RegistryService,
        ConfigService,
        GatewayAuthGuard,
      ],
      exports: [
        ENV,
        RedisService,
        MemberIdentityService,
        RegistryService,
        ConfigService,
        GatewayAuthGuard,
        ManualModule,
      ],
    };
  }
}
