import { Module } from '@nestjs/common';
import { WecomBotService } from './wecom-bot.service';
import { WecomGroupMessageService } from './wecom-group-message.service';
import { WecomController } from './wecom.controller';
import { ENV, loadEnv } from '../../config/env';
import { PipelineModule } from '../pipeline/pipeline.module';

@Module({
  imports: [PipelineModule],
  controllers: [WecomController],
  providers: [
    {
      provide: ENV,
      useFactory: () => loadEnv(),
    },
    WecomGroupMessageService,
    WecomBotService,
  ],
  exports: [WecomBotService, WecomGroupMessageService],
})
export class WecomModule {}
