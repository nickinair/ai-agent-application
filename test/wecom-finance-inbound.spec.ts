import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { WecomController } from '../src/modules/wecom/wecom.controller';
import { WecomBotService } from '../src/modules/wecom/wecom-bot.service';
import { WecomGroupMessageService } from '../src/modules/wecom/wecom-group-message.service';
import { ENV } from '../src/config/env';
import { InboundFinanceEventDto } from '../src/modules/wecom/types/wecom-finance-inbound.dto';

describe('企业微信会话存档事件接收端点与处理流水线 (WecomFinanceInbound)', () => {
  let controller: WecomController;
  let groupMessageService: WecomGroupMessageService;

  const mockEnv: any = {
    PORT: 3002,
    WECOM_BOT_ENABLED: true,
    WECOM_STAFF_MENTIONS: '@客服',
    WECOM_SIDECAR_TOKEN: 'secret_sidecar_token_123',
  };

  const sampleEvent: InboundFinanceEventDto = {
    seq: 101,
    msgid: 'MSG_FINANCE_TEST_001',
    isExternalRoom: true,
    roomid: 'wr_customer_room_88',
    sender: 'wm_customer_vip',
    timestamp: Date.now(),
    msgtype: 'text',
    contentSummary: '请问续约折扣是多少？',
    payload: {
      msgid: 'MSG_FINANCE_TEST_001',
      action: 'send',
      from: 'wm_customer_vip',
      tolist: ['sales_01'],
      roomid: 'wr_customer_room_88',
      msgtime: Date.now(),
      msgtype: 'text',
      text: { content: '请问续约折扣是多少？' },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WecomController],
      providers: [
        {
          provide: ENV,
          useValue: mockEnv,
        },
        {
          provide: WecomBotService,
          useValue: {
            getStatus: jest.fn().mockReturnValue({ configured: true }),
          },
        },
        WecomGroupMessageService,
      ],
    }).compile();

    controller = module.get<WecomController>(WecomController);
    groupMessageService = module.get<WecomGroupMessageService>(WecomGroupMessageService);
  });

  describe('1. 鉴权与接口安全校验', () => {
    it('缺少或错误的 x-sidecar-token 时应拒绝访问 (401)', async () => {
      // 无 token
      await expect(
        controller.handleFinanceInbound(sampleEvent, undefined),
      ).rejects.toThrow(UnauthorizedException);

      // 错误 token
      await expect(
        controller.handleFinanceInbound(sampleEvent, 'wrong_token'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('提供正确的 x-sidecar-token 时应成功放行并处理', async () => {
      const response = await controller.handleFinanceInbound(
        sampleEvent,
        'secret_sidecar_token_123',
      );
      expect(response).toEqual({
        code: 0,
        message: 'success',
        handled: true,
      });
    });
  });

  describe('2. 服务层消息消费与幂等防重', () => {
    it('首次接收到新消息时正常记录并统计', async () => {
      const uniqueEvent = {
        ...sampleEvent,
        msgid: `MSG_UNIQUE_${Date.now()}`,
      };
      const res = await groupMessageService.handleFinanceInboundEvent(uniqueEvent);
      expect(res.success).toBe(true);
      expect(res.handled).toBe(true);

      const stats = groupMessageService.getStats();
      expect(stats.receivedCount).toBeGreaterThanOrEqual(1);
    });

    it('重复的 msgid 应被幂等忽略', async () => {
      const dupId = `MSG_DUP_${Date.now()}`;
      const event = { ...sampleEvent, msgid: dupId };

      const res1 = await groupMessageService.handleFinanceInboundEvent(event);
      expect(res1.handled).toBe(true);

      const res2 = await groupMessageService.handleFinanceInboundEvent(event);
      expect(res2.handled).toBe(false); // 重复消息不再重复处理
    });
  });
});
