import { InboundFinanceEvent } from '../types/finance.types';

export interface HttpDispatcherOptions {
  /** 接收事件的 a3 Webhook URL，如 http://127.0.0.1:3000/api/admin/wecom/finance-inbound */
  webhookUrl: string;
  /** 内部安全认证令牌（放在 x-sidecar-token 请求头） */
  secretToken?: string;
  /** 单次请求超时时间 (毫秒，默认 5000) */
  timeoutMs?: number;
  /** 最大重试次数 (默认 3 次) */
  maxRetries?: number;
}

/**
 * Sidecar HTTP 事件分发投递器
 * 负责将解密后的会话存档事件安全、可靠地投递给 a3 主应用
 */
export class HttpDispatcher {
  private webhookUrl: string;
  private secretToken?: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(options: HttpDispatcherOptions) {
    this.webhookUrl = options.webhookUrl;
    this.secretToken = options.secretToken;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * 向 a3 投递单条事件
   */
  public async dispatch(event: InboundFinanceEvent): Promise<boolean> {
    if (!this.webhookUrl) {
      console.warn('[HttpDispatcher] 未配置 A3_WEBHOOK_URL，跳过事件投递');
      return true;
    }

    const payload = JSON.stringify(event);
    let attempt = 0;

    while (attempt < this.maxRetries) {
      attempt++;
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'Wecom-Finance-Sidecar/1.0',
        };

        if (this.secretToken) {
          headers['x-sidecar-token'] = this.secretToken;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          return true;
        }

        const errorText = await response.text().catch(() => '');
        console.warn(
          `[HttpDispatcher] a3 响应非成功状态码: ${response.status} (尝试 ${attempt}/${this.maxRetries}): ${errorText}`
        );
      } catch (err: any) {
        console.warn(
          `[HttpDispatcher] 投递事件网络异常 (尝试 ${attempt}/${this.maxRetries}): ${err.message}`
        );
      }

      if (attempt < this.maxRetries) {
        // 退避 500ms, 1000ms
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }

    throw new Error(
      `[HttpDispatcher] 投递事件给 a3 连续失败 ${this.maxRetries} 次 (Seq=${event.seq}, MsgID=${event.msgid})`
    );
  }
}
