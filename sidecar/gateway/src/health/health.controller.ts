import { Controller, Get } from '@nestjs/common';
import { RedisService } from '../infra/redis.service';
import { RegistryService } from '../registry/registry.service';

@Controller('health')
export class HealthController {
  private readonly startTime = Date.now();

  constructor(
    private readonly redisService: RedisService,
    private readonly registryService: RegistryService,
  ) {}

  @Get()
  async check(): Promise<Record<string, unknown>> {
    const redisOk = await this.redisService.ping();
    const services = await this.registryService.getServices();

    return {
      status: redisOk ? 'ok' : 'degraded',
      service: 'a3-internal-gateway',
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      components: {
        redis: redisOk ? 'UP' : 'DOWN',
        activeServicesCount: services.length,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
