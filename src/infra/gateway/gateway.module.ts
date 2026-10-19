import { Module } from '@nestjs/common';
import { GatewayRegistryService } from './gateway-registry.service';
import { GatewayConfigService } from './gateway-config.service';

@Module({
  providers: [GatewayRegistryService, GatewayConfigService],
  exports: [GatewayRegistryService, GatewayConfigService],
})
export class GatewayModule {}

