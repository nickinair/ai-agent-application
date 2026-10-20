import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { WecomBotService } from './wecom-bot.service';
import { WecomGroupMessageService } from './wecom-group-message.service';
import { ENV, type Env } from '../../config/env';
import type { WecomBotStatus } from './types/wecom.types';
import type { InboundFinanceEventDto } from './types/wecom-finance-inbound.dto';
import { Public } from '../../auth/tenant-context';

@Controller('wecom')
export class WecomController {
  constructor(
    private readonly botService: WecomBotService,
    private readonly groupMessageService: WecomGroupMessageService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * 获取企业微信智能机器人运行状态与长连接指标
   * GET /api/admin/wecom/status
   */
  @Get('status')
  getStatus(): { code: number; data: WecomBotStatus } {
    return {
      code: 0,
      data: this.botService.getStatus(),
    };
  }

  /**
   * 接收来自 wecom-finance Sidecar 模块投递的会话内容存档全量群事件
   * POST /api/admin/wecom/finance-inbound
   * Sidecar 不带管理 API 的登录令牌，只用 x-sidecar-token 鉴权；生产环境没配 WECOM_SIDECAR_TOKEN 时一律拒绝
   */
  @Public()
  @Post('finance-inbound')
  @HttpCode(HttpStatus.OK)
  async handleFinanceInbound(
    @Body() body: InboundFinanceEventDto,
    @Headers('x-sidecar-token') sidecarToken?: string,
  ): Promise<{ code: number; message: string; handled: boolean }> {
    // 若配置了 WECOM_SIDECAR_TOKEN，则执行强校验
    if (!this.env.WECOM_SIDECAR_TOKEN && this.env.NODE_ENV === 'production') {
      throw new UnauthorizedException('未配置 WECOM_SIDECAR_TOKEN，拒绝接收存档事件');
    }
    if (this.env.WECOM_SIDECAR_TOKEN) {
      if (!sidecarToken || sidecarToken !== this.env.WECOM_SIDECAR_TOKEN) {
        throw new UnauthorizedException('无效或未提供 x-sidecar-token 鉴权凭证');
      }
    }

    const result = await this.groupMessageService.handleFinanceInboundEvent(body);
    return {
      code: 0,
      message: 'success',
      handled: result.handled,
    };
  }

  /**
   * 测试主动向指定会话/群聊下发消息
   * POST /api/admin/wecom/test-send
   */
  @Public()
  @Post('test-send')
  @HttpCode(HttpStatus.OK)
  async testSend(
    @Body() body: { chatId: string; content: string },
  ): Promise<{ code: number; message: string; data?: any }> {
    const client = this.botService.getClient();
    if (!client) {
      throw new Error('企业微信智能机器人长连接未建立，无法发送');
    }
    const res = await client.sendMessage(body.chatId, {
      msgtype: 'markdown',
      markdown: { content: body.content },
    });
    return {
      code: 0,
      message: 'success',
      data: res,
    };
  }
}
