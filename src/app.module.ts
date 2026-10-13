import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConversationsController } from './admin/conversations.controller';
import { HandoffsController } from './admin/handoffs.controller';
import { MembersController } from './admin/members.controller';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { ENV, loadEnv } from './config/env';
import { MysqlService } from './database/mysql.service';
import { HealthController } from './health/health.controller';
import { ConfigNotifier } from './infra/config-notifier';

@Module({
  controllers: [HealthController, AuthController, ConversationsController, HandoffsController, MembersController],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    MysqlService,
    AuthService,
    ConfigNotifier,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
