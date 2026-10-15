import { Test } from '@nestjs/testing';
import { WecomGroupMessageService } from '../src/modules/wecom/wecom-group-message.service';
import { WecomBotService } from '../src/modules/wecom/wecom-bot.service';
import { ENV, type Env } from '../src/config/env';
import { MessageType } from '@wecom/aibot-node-sdk';
import type { BaseMessage, TextMessage, WsFrame, WSClient } from '@wecom/aibot-node-sdk';

describe('企业微信群聊消息模块 (WecomGroupMessageService)', () => {
  let service: WecomGroupMessageService;
  const mockEnv: Env = {
    PORT: 3002,
    MYSQL_URL: 'mysql://mock',
    WECOM_BOT_ID: 'aibO5Qj0HQo7eJH2J7DNAWMi-LqKHSF0Gdh',
    WECOM_BOT_SECRET: '8n8UQAnz3XMvQAQRjrN2OrWQVCZLnQ9fsSQLSf7Uq2Y',
    WECOM_BOT_ENABLED: true,
    WECOM_STAFF_MENTIONS: '@客服',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: 6379,
    REDIS_DB: 0,
    CRM_BASE_URL: 'http://localhost:3001',
    CRM_SERVICE_TOKEN: 'token',
    CRM_TIMEOUT_MS: 800,
    QUIET_WINDOW_MS: 3000,
    HARD_TIMEOUT_MS: 15000,
    GROUP_MAX_MESSAGES: 5,
  };

  beforeEach(() => {
    service = new WecomGroupMessageService(mockEnv);
  });

  describe('文本消息清洗 (cleanMentionText)', () => {
    it('应过滤前缀的 @机器人 名称及后续空格', () => {
      const raw = '@智能助理 请问现在的营业时间是什么？';
      const cleaned = service.cleanMentionText(raw);
      expect(cleaned).toBe('请问现在的营业时间是什么？');
    });

    it('应过滤包含英文字符与特殊符号的 @ 标记', () => {
      const raw = '@Bot_001 你好，测试一下';
      const cleaned = service.cleanMentionText(raw);
      expect(cleaned).toBe('你好，测试一下');
    });

    it('没有 @ 时应保留原文本并去除前后首尾空格', () => {
      const raw = '  直接发送的问题  ';
      const cleaned = service.cleanMentionText(raw);
      expect(cleaned).toBe('直接发送的问题');
    });

    it('空字符串应返回空', () => {
      expect(service.cleanMentionText('')).toBe('');
    });
  });

  describe('多类型消息解析 (parseIncomingMessage)', () => {
    it('正确解析文本消息 (text)', () => {
      const frame: WsFrame<TextMessage> = {
        headers: { req_id: 'req_text' },
        body: {
          msgid: 'msg_text_01',
          aibotid: 'bot_01',
          chatid: 'chat_group_1',
          chattype: 'group',
          from: { userid: 'zhangsan' },
          msgtype: MessageType.Text,
          text: { content: '@AI客服 怎么办理退款？' },
          create_time: 1728800000,
        },
      };

      const parsed = service.parseIncomingMessage(frame);
      expect(parsed).not.toBeNull();
      expect(parsed?.msgType).toBe('text');
      expect(parsed?.content).toBe('@AI客服 怎么办理退款？');
      expect(parsed?.cleanedContent).toBe('怎么办理退款？');
      expect(parsed?.requiresHumanHandoff).toBe(false);
    });

    it('正确解析语音消息 (voice) 并提取服务端自动转写文字', () => {
      const frame: WsFrame<BaseMessage> = {
        headers: { req_id: 'req_voice' },
        body: {
          msgid: 'msg_voice_01',
          aibotid: 'bot_01',
          chatid: 'chat_group_1',
          chattype: 'group',
          from: { userid: 'lisi' },
          msgtype: 'voice',
          voice: { content: '今天天气怎么样' },
          create_time: 1728800005,
        },
      };

      const parsed = service.parseIncomingMessage(frame);
      expect(parsed).not.toBeNull();
      expect(parsed?.msgType).toBe('voice');
      expect(parsed?.content).toBe('今天天气怎么样');
      expect(parsed?.cleanedContent).toBe('今天天气怎么样');
      expect(parsed?.requiresHumanHandoff).toBe(false);
    });

    it('正确解析图片消息 (image) 并标记 requiresHumanHandoff', () => {
      const frame: WsFrame<BaseMessage> = {
        headers: { req_id: 'req_image' },
        body: {
          msgid: 'msg_img_01',
          aibotid: 'bot_01',
          chatid: 'chat_group_1',
          chattype: 'group',
          from: { userid: 'wangwu' },
          msgtype: 'image',
          image: { url: 'https://example.com/img.jpg', aeskey: 'aes123' },
        },
      };

      const parsed = service.parseIncomingMessage(frame);
      expect(parsed).not.toBeNull();
      expect(parsed?.msgType).toBe('image');
      expect(parsed?.requiresHumanHandoff).toBe(true);
      expect(parsed?.mediaInfo?.url).toBe('https://example.com/img.jpg');
      expect(parsed?.mediaInfo?.hasAesKey).toBe(true);
    });

    it('正确解析文件消息 (file) 与视频消息 (video)', () => {
      const fileFrame: WsFrame<BaseMessage> = {
        headers: { req_id: 'req_file' },
        body: {
          msgid: 'msg_file_01',
          aibotid: 'bot_01',
          chatid: 'chat_group_1',
          chattype: 'group',
          from: { userid: 'zhaoliu' },
          msgtype: 'file',
          file: { url: 'https://example.com/doc.pdf', aeskey: 'key_pdf' },
        },
      };

      const parsedFile = service.parseIncomingMessage(fileFrame);
      expect(parsedFile?.msgType).toBe('file');
      expect(parsedFile?.requiresHumanHandoff).toBe(true);
      expect(parsedFile?.mediaInfo?.url).toBe('https://example.com/doc.pdf');
    });

    it('正确解析引用消息 (quote)', () => {
      const quoteFrame: WsFrame<BaseMessage> = {
        headers: { req_id: 'req_quote' },
        body: {
          msgid: 'msg_quote_01',
          aibotid: 'bot_01',
          chatid: 'chat_group_1',
          chattype: 'group',
          from: { userid: 'user_quote' },
          msgtype: 'text',
          text: { content: '确认这个报价吗？' },
          quote: {
            msgtype: 'text',
            text: { content: '商品单价为 99 元' },
          },
        },
      };

      const parsed = service.parseIncomingMessage(quoteFrame);
      expect(parsed?.quote).toEqual({
        msgType: 'text',
        text: '商品单价为 99 元',
      });
    });
  });

  describe('消息处理与转人工逻辑 (handleIncomingMessage)', () => {
    const frameOf = (msgid: string, userid: string, body: Record<string, unknown>): WsFrame<BaseMessage> => ({
      headers: { req_id: `req_${msgid}` },
      body: { msgid, aibotid: 'bot_test', chatid: 'chat_1', chattype: 'group', from: { userid }, ...body } as any,
    });
    const setup = (roles: Record<string, string> = {}) => {
      const onInbound = jest.fn().mockResolvedValue({ status: 'PROCESSED' });
      const memberRoles = {
        tenantId: jest.fn().mockResolvedValue(7),
        resolve: jest.fn(async (_t: number, _c: string, _chat: string, id: string) => ({ role: roles[id] ?? 'CUSTOMER', source: 'CHANNEL' })),
      };
      const svc = new WecomGroupMessageService(mockEnv, { onInbound } as any, memberRoles as any);
      const replyStream = jest.fn();
      return { svc, onInbound, memberRoles, client: { replyStream } as unknown as WSClient, replyStream };
    };

    it('文本与语音消息交给流水线，不在群里本地应答（回复由流水线发出）', async () => {
      const { svc, onInbound, client, replyStream } = setup();
      await svc.handleIncomingMessage(client, frameOf('msg_t1', 'wmCustomer001', { msgtype: 'text', text: { content: '@机器人 查下物流' } }));
      await svc.handleIncomingMessage(client, frameOf('msg_v1', 'wmCustomer001', { msgtype: 'voice', voice: { content: '帮我开通权限' } }));
      expect(replyStream).not.toHaveBeenCalled();
      expect(onInbound).toHaveBeenCalledTimes(2);
      expect(onInbound.mock.calls[0][0]).toMatchObject({ tenantId: 7, channel: 'wecom_group', channelChatId: 'chat_1', type: 'text', text: '查下物流', sender: { role: 'CUSTOMER', channelUserId: 'wmCustomer001' } });
      expect(onInbound.mock.calls[1][0]).toMatchObject({ type: 'voice', text: '帮我开通权限' });
    });

    it('图片 / 文件也交给流水线（组内以占位处理），不再本地转人工应答', async () => {
      const { svc, onInbound, client, replyStream } = setup();
      await svc.handleIncomingMessage(client, frameOf('msg_img', 'wmCustomer001', { msgtype: 'image', image: { url: 'https://example.com/screen.png' } }));
      expect(replyStream).not.toHaveBeenCalled();
      expect(onInbound.mock.calls[0][0]).toMatchObject({ type: 'image', mediaUrl: 'https://example.com/screen.png' });
    });

    it('按识别结果带上发送人角色；机器人自己的消息不进流水线', async () => {
      const { svc, onInbound, memberRoles, client } = setup({ zhangsan: 'STAFF_CS', lisi: 'STAFF_OTHER', bot_self: 'BOT' });
      await svc.handleIncomingMessage(client, frameOf('m1', 'zhangsan', { msgtype: 'text', text: { content: '我来处理' } }));
      await svc.handleIncomingMessage(client, frameOf('m2', 'lisi', { msgtype: 'text', text: { content: '收到' } }));
      await svc.handleIncomingMessage(client, frameOf('m3', 'bot_self', { msgtype: 'text', text: { content: '自己发的' } }));
      expect(memberRoles.resolve).toHaveBeenCalledWith(7, 'wecom_group', 'chat_1', 'zhangsan');
      expect(onInbound.mock.calls.map((c) => c[0].sender.role)).toEqual(['STAFF_CS', 'STAFF_OTHER']);
    });

    it('结构化日志打印方法调用不报错', () => {
      const sampleMsg = service.parseIncomingMessage({
        headers: { req_id: 'req_log' },
        body: {
          msgid: 'msg_log_01',
          aibotid: 'bot_1',
          chatid: 'chat_1',
          chattype: 'group',
          from: { userid: 'user_log' },
          msgtype: 'voice',
          voice: { content: '测试日志输出' },
        },
      });

      expect(() => service.logIncomingMessage(sampleMsg!)).not.toThrow();
    });
  });
});

describe('企业微信机器人生命周期与状态服务 (WecomBotService)', () => {
  it('未配置凭证时应优雅降级且不抛出异常', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        WecomBotService,
        WecomGroupMessageService,
        {
          provide: ENV,
          useValue: {
            PORT: 3002,
            MYSQL_URL: 'mysql://mock',
            WECOM_BOT_ID: undefined,
            WECOM_BOT_SECRET: undefined,
            WECOM_BOT_ENABLED: true,
            WECOM_STAFF_MENTIONS: '@客服',
          },
        },
      ],
    }).compile();

    const botService = moduleRef.get(WecomBotService);
    await expect(botService.onModuleInit()).resolves.not.toThrow();

    const status = botService.getStatus();
    expect(status.configured).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.authenticated).toBe(false);
    expect(status.botId).toBeNull();
  });

  it('配置了凭证时 getStatus 应脱敏返回 Bot ID 并提供 handoff 统计', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        WecomBotService,
        WecomGroupMessageService,
        {
          provide: ENV,
          useValue: {
            PORT: 3002,
            MYSQL_URL: 'mysql://mock',
            WECOM_BOT_ID: 'aibO5Qj0HQo7eJH2J7DNAWMi-LqKHSF0Gdh',
            WECOM_BOT_SECRET: '8n8UQAnz3XMvQAQRjrN2OrWQVCZLnQ9fsSQLSf7Uq2Y',
            WECOM_BOT_ENABLED: true,
            WECOM_STAFF_MENTIONS: '@客服',
          },
        },
      ],
    }).compile();

    const botService = moduleRef.get(WecomBotService);
    const status = botService.getStatus();

    expect(status.configured).toBe(true);
    expect(status.botId).toBe('aibO****0Gdh');
    expect(status.stats.totalHandoffCount).toBe(0);
  });
});
