import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ManualService } from './manual.service';
import { ManualController } from './manual.controller';

@Module({
  imports: [DiscoveryModule],
  controllers: [ManualController],
  providers: [ManualService],
  exports: [ManualService],
})
export class ManualModule {}
