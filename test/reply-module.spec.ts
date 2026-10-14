import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { ReplyDispatcherService } from '../src/modules/reply/reply-dispatcher.service';
import { FinalCheckService } from '../src/modules/pipeline/final-check.service';
import { ChannelRouter } from '../src/modules/reply/channel-router';
import { WecomBotService } from '../src/modules/wecom/wecom-bot.service';
/** 发送端接入 AppModule：适配器注入到运行时末检与入站流水线，且没有循环依赖（循环时 compile 会卡住） */
it('AppModule 能装配发送端，CHANNEL_ADAPTER 按渠道路由（企微 / 测试记录）', async () => {
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  expect(m.get(ReplyDispatcherService)).toBeDefined();
  const adapter = (m.get(FinalCheckService) as any).channelAdapter;
  expect(adapter).toBeInstanceOf(ChannelRouter);
  await expect(adapter.send({ channel: 'wecom_group', channelChatId: 'x', text: 'y' })).rejects.toThrow('长连接未建立');
  expect(adapter.wecom.bot).toBe(m.get(WecomBotService, { strict: false }));
  await m.close();
}, 20000);
