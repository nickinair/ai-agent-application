/**
 * @file pipeline.module.ts
 * @description 智能体全能平台核心流水线模块（缓冲池、双计时器、客户装配与封组器）
 */

import { Module } from '@nestjs/common';
import { BufferService } from './buffer.service';
import { TimerService } from './timer.service';
import { CustomerContextService } from './customer-context.service';
import { SealerService } from './sealer.service';
import { InboundPipelineService } from './inbound-pipeline.service';

import { StateTransitionService } from './state-transition.service';
import { WatchdogService } from './watchdog.service';
import { MicrophoneService } from './microphone.service';
import { FinalCheckService } from './final-check.service';
import { MetricsService } from '../../infra/metrics.service';

@Module({
  providers: [
    BufferService,
    TimerService,
    CustomerContextService,
    SealerService,
    InboundPipelineService,
    StateTransitionService,
    WatchdogService,
    MicrophoneService,
    FinalCheckService,
    MetricsService,
  ],
  exports: [
    BufferService,
    TimerService,
    CustomerContextService,
    SealerService,
    InboundPipelineService,
    StateTransitionService,
    WatchdogService,
    MicrophoneService,
    FinalCheckService,
    MetricsService,
  ],
})
export class PipelineModule {}
