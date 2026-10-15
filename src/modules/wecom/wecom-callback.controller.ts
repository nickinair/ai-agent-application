/**
 * @file wecom-callback.controller.ts
 * @description 企业微信接收事件服务器 Webhook 回调控制器 (GET 验签 + POST 事件接收)
 * @reference 企业微信开发文档：https://developer.work.weixin.qq.com/document/path/90968
 */

import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Public } from '../../auth/tenant-context';
import { ENV, type Env } from '../../config/env';
import { InboundPipelineService } from '../pipeline/inbound-pipeline.service';
import { WecomCrypto } from './crypto/wecom-crypto';
import type { InboundMessage } from '../../contracts';

@Controller('api/wecom')
export class WecomCallbackController {
  private readonly logger = new Logger(WecomCallbackController.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly inboundService: InboundPipelineService,
  ) {}

  /**
   * 1. 响应企业微信后台点击【保存】时的 URL 有效性校验 (GET)
   * 企业微信会发送 msg_signature, timestamp, nonce, echostr
   * 服务端解密 echostr 并原样输出即代表验证成功
   */
  @Public()
  @Get('callback')
  verifyUrl(
    @Query('msg_signature') msgSignature: string,
    @Query('timestamp') timestamp: string,
    @Query('nonce') nonce: string,
    @Query('echostr') echostr: string,
    @Res() res: any,
  ): void {
    this.logger.log(
      `收到企业微信 URL 验证请求: timestamp=${timestamp}, nonce=${nonce}, msg_signature=${msgSignature}`,
    );

    if (!msgSignature || !timestamp || !nonce || !echostr) {
      throw new BadRequestException('缺少企业微信 URL 验签必需参数');
    }

    const token = this.env.WECOM_CALLBACK_TOKEN;
    const aesKey = this.env.WECOM_CALLBACK_AES_KEY;

    if (!token || !aesKey) {
      this.logger.error('未配置 WECOM_CALLBACK_TOKEN 或 WECOM_CALLBACK_AES_KEY，无法完成验签');
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Configuration error');
      return;
    }

    try {
      const cryptoHelper = new WecomCrypto(token, aesKey, this.env.WECOM_CORPID);
      const plainEcho = cryptoHelper.verifyAndDecryptEchoStr(
        msgSignature,
        timestamp,
        nonce,
        echostr,
      );

      this.logger.log(`企业微信 URL 验签成功！回显明文长度: ${plainEcho.length}`);
      res.status(HttpStatus.OK).type('text/plain').send(plainEcho);
    } catch (err: any) {
      this.logger.error(`企业微信 URL 验签失败: ${err.message}`, err.stack);
      res.status(HttpStatus.FORBIDDEN).send(`Validation failed: ${err.message}`);
    }
  }

  /**
   * 2. 接收企业微信推送的加密消息与事件回调 (POST)
   * 解密 XML 报文，提取发送人、群ID与内容，转化为 InboundMessage 投递进入缓冲池流水线
   */
  @Public()
  @Post('callback')
  @HttpCode(HttpStatus.OK)
  async handleCallback(
    @Query('msg_signature') msgSignature: string,
    @Query('timestamp') timestamp: string,
    @Query('nonce') nonce: string,
    @Req() req: any,
    @Res() res: any,
  ): Promise<void> {
    const token = this.env.WECOM_CALLBACK_TOKEN;
    const aesKey = this.env.WECOM_CALLBACK_AES_KEY;

    if (!token || !aesKey) {
      this.logger.error('未配置 WECOM_CALLBACK_TOKEN 或 WECOM_CALLBACK_AES_KEY，无法解密回调消息');
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Configuration error');
      return;
    }

    // 读取原始 XML 密文
    let rawXml = '';
    if (typeof req.body === 'string') {
      rawXml = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      rawXml = req.body.toString('utf8');
    } else if (req.body && typeof req.body === 'object') {
      // 若已有中间件解析为对象
      rawXml = (req.body.xml && req.body.xml.Encrypt) ? `<xml><Encrypt>${req.body.xml.Encrypt}</Encrypt></xml>` : JSON.stringify(req.body);
    }

    try {
      const cryptoHelper = new WecomCrypto(token, aesKey, this.env.WECOM_CORPID);
      const decryptedXml = cryptoHelper.verifyAndDecryptXml(
        msgSignature,
        timestamp,
        nonce,
        rawXml,
      );

      this.logger.log(`成功解密企微回调报文: ${decryptedXml.slice(0, 200)}...`);

      // 解析 XML 基础关键标签
      const parsed = this.parseSimpleXml(decryptedXml);
      const msgType = parsed.MsgType;

      if (msgType === 'text') {
        const fromUser = parsed.FromUserName || 'UNKNOWN';
        const chatId = parsed.ChatId || parsed.FromUserName || 'single_chat';
        const content = parsed.Content || '';
        const msgId = parsed.MsgId || `wecom-${randomUUID()}`;
        const sentAt = parsed.CreateTime ? Number(parsed.CreateTime) * 1000 : Date.now();

        const inboundMsg: InboundMessage = {
          tenantId: this.env.WECOM_TENANT_ID ?? 1,
          channel: parsed.ChatId ? 'wecom_group' : 'wecom_single',
          channelChatId: chatId,
          channelMsgId: msgId,
          sender: {
            channelUserId: fromUser,
            role: 'CUSTOMER',
            name: fromUser,
          },
          type: 'text',
          text: content,
          mentions: [],
          sentAt,
        };

        // 异步送入统一入站流水线（进入 3s 静默缓冲池与封组状态机）
        await this.inboundService.onInbound(inboundMsg);
      } else {
        this.logger.log(`收到非文本消息/事件: MsgType=${msgType}, Event=${parsed.Event}, 暂不入缓冲池`);
      }

      // 企业微信要求接收成功必须返回明文 success 或空字符串
      res.status(HttpStatus.OK).type('text/plain').send('success');
    } catch (err: any) {
      this.logger.error(`处理企业微信回调异常: ${err.message}`, err.stack);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('error');
    }
  }

  /**
   * 极简提取企微 XML 报文的一级标签文本（避免引入重型外部 XML 依赖）
   */
  private parseSimpleXml(xml: string): Record<string, string> {
    const result: Record<string, string> = {};
    const regex = /<([a-zA-Z0-9_]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*?))<\/\1>/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(xml)) !== null) {
      if (match[1] !== 'xml') {
        result[match[1]] = (match[2] ?? match[3] ?? '').trim();
      }
    }
    return result;
  }
}
