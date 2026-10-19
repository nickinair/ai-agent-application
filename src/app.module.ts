import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConversationsController } from './admin/conversations.controller';
import { HandoffsController } from './admin/handoffs.controller';
import { MembersController } from './admin/members.controller';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { ENV, loadEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { WecomModule } from './modules/wecom/wecom.module';
import { RedisModule } from './infra/redis/redis.module';
import { QueueModule } from './infra/queue/queue.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { ConfigNotifier } from './infra/config-notifier';
import { ReplyModule } from './modules/reply/reply.module';
import { GatewayModule } from './infra/gateway/gateway.module';

@Module({
  imports: [
    DatabaseModule,
    RedisModule,
    QueueModule,
    PipelineModule,
    WecomModule,
    ReplyModule,
    GatewayModule,
  ],
  controllers: [
    HealthController,
    AuthController,
    ConversationsController,
    HandoffsController,
    MembersController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    AuthService,
    ConfigNotifier,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
