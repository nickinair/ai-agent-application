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
   */
  @Post('finance-inbound')
  @HttpCode(HttpStatus.OK)
  async handleFinanceInbound(
    @Body() body: InboundFinanceEventDto,
    @Headers('x-sidecar-token') sidecarToken?: string,
  ): Promise<{ code: number; message: string; handled: boolean }> {
    // 若配置了 WECOM_SIDECAR_TOKEN，则执行强校验
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
}
