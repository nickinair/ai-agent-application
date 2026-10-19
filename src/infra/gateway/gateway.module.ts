import { Module } from '@nestjs/common';
import { GatewayRegistryService } from './gateway-registry.service';

@Module({
  providers: [GatewayRegistryService],
  exports: [GatewayRegistryService],
})
export class GatewayModule {}
