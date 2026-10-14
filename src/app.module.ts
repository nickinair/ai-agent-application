import { Module } from '@nestjs/common';
import { ENV, loadEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { WecomModule } from './modules/wecom/wecom.module';
import { RedisModule } from './infra/redis/redis.module';
import { QueueModule } from './infra/queue/queue.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';

@Module({
  imports: [DatabaseModule, RedisModule, QueueModule, PipelineModule, WecomModule],
  controllers: [HealthController],
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
})
export class AppModule {}
