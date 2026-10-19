import { Module } from '@nestjs/common';
import { WecomBotService } from './wecom-bot.service';
import { WecomGroupMessageService } from './wecom-group-message.service';
import { WecomMemberRoleService } from './wecom-member-role.service';
import { WecomController } from './wecom.controller';
import { WecomCallbackController } from './wecom-callback.controller';
import { ENV, loadEnv } from '../../config/env';
import { PipelineModule } from '../pipeline/pipeline.module';

import { GatewayModule } from '../../infra/gateway/gateway.module';

@Module({
  imports: [PipelineModule, GatewayModule],
  controllers: [WecomController, WecomCallbackController],
  providers: [
    {
      provide: ENV,
      useFactory: () => loadEnv(),
    },
    WecomGroupMessageService,
    WecomBotService,
    WecomMemberRoleService,
  ],
  exports: [WecomBotService, WecomGroupMessageService],
})
export class WecomModule {}
