import { Module } from '@nestjs/common';
import { ENV, loadEnv } from './config/env';
import { MysqlService } from './database/mysql.service';
import { HealthController } from './health/health.controller';
import { WecomModule } from './modules/wecom/wecom.module';
import { RedisModule } from './infra/redis/redis.module';
import { QueueModule } from './infra/queue/queue.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';

@Module({
  imports: [RedisModule, QueueModule, PipelineModule, WecomModule],
  controllers: [HealthController],
  providers: [{ provide: ENV, useFactory: () => loadEnv() }, MysqlService],
})
export class AppModule {}
