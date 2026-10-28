import { IFinanceDriver } from '../driver/driver.interface';
import { FinanceCrypto } from '../crypto/finance-crypto';
import { SeqManager } from '../cursor/seq-manager';
import {
  DecryptedFinanceMessage,
  EncryptedChatData,
  FinanceSidecarConfig,
  InboundFinanceEvent,
} from '../types/finance.types';
import { HttpDispatcher } from '../dispatcher/http-dispatcher';

export type FinanceMessageHandler = (event: InboundFinanceEvent) => Promise<void> | void;

export class FinanceWorker {
  private driver: IFinanceDriver;
  private crypto: FinanceCrypto;
  private seqManager: SeqManager;
  private config: FinanceSidecarConfig;
  private isRunning: boolean = false;
  private messageHandler?: FinanceMessageHandler;
  private dispatcher?: HttpDispatcher;

  constructor(
    driver: IFinanceDriver,
    crypto: FinanceCrypto,
    seqManager: SeqManager,
    config: FinanceSidecarConfig,
    messageHandler?: FinanceMessageHandler,
    dispatcher?: HttpDispatcher,
  ) {
    this.driver = driver;
    this.crypto = crypto;
    this.seqManager = seqManager;
    this.config = config;
    this.messageHandler = messageHandler;

    if (dispatcher) {
      this.dispatcher = dispatcher;
    } else if (config.a3WebhookUrl) {
      this.dispatcher = new HttpDispatcher({
        webhookUrl: config.a3WebhookUrl,
        secretToken: config.a3WebhookSecret,
      });
    }
  }

  /**
   * 动态更新运行态参数 (由网关 CC 热通知触发)
   */
  public updateConfig(newConfig: Partial<FinanceSidecarConfig>): void {
    if (newConfig.pollIntervalMs !== undefined && !isNaN(Number(newConfig.pollIntervalMs))) {
      this.config.pollIntervalMs = Number(newConfig.pollIntervalMs);
    }
    if (newConfig.batchSize !== undefined && !isNaN(Number(newConfig.batchSize))) {
      this.config.batchSize = Number(newConfig.batchSize);
    }
    if (newConfig.corpid) {
      this.config.corpid = String(newConfig.corpid);
    }
    if (newConfig.secret) {
      this.config.secret = String(newConfig.secret);
    }
    console.log(
      `[FinanceWorker] 收到网关配置热更: 轮询间隔=${this.config.pollIntervalMs}ms, 批次大小=${this.config.batchSize}`,
    );
  }

  /**
   * 启动长轮询拉取守护工作进程
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    console.log(
      `[FinanceWorker] 启动会话内容存档守护进程: 模式=${this.config.driverMode}, 当前游标Seq=${this.seqManager.getSeq()}, 批次大小=${this.config.batchSize}, 轮询间隔=${this.config.pollIntervalMs}ms`
    );

    let consecutiveErrors = 0;

    while (this.isRunning) {
      try {
        const currentSeq = this.seqManager.getSeq();
        const chatDataList = await this.driver.fetchChatData(currentSeq, this.config.batchSize);

        if (chatDataList.length === 0) {
          // 当前无未读新消息，正常等待下一个轮询周期
          await this.sleep(this.config.pollIntervalMs);
          consecutiveErrors = 0;
          continue;
        }

        console.log(`[FinanceWorker] 本批次拉取到 ${chatDataList.length} 条加密消息 (游标起点: ${currentSeq})`);

        let maxSeq = currentSeq;

        for (const item of chatDataList) {
          if (!this.isRunning) break;

          try {
            await this.processItem(item);
            if (item.seq > maxSeq) {
              maxSeq = item.seq;
            }
          } catch (itemErr: any) {
            console.error(`[FinanceWorker] 解析消息失败 (seq=${item.seq}, msgid=${item.msgid}): ${itemErr.message}`);
            // 依然推进游标，避免单条异常毒丸消息死锁整个拉取流水线
            if (item.seq > maxSeq) {
              maxSeq = item.seq;
            }
          }
        }

        // 本批次处理完毕，原子持久化游标
        this.seqManager.updateSeq(maxSeq);
        consecutiveErrors = 0;

        // 若拉满了批次，立即继续拉下一批，无需长时间 sleep
        if (chatDataList.length >= this.config.batchSize) {
          await this.sleep(100);
        } else {
          await this.sleep(this.config.pollIntervalMs);
        }
      } catch (err: any) {
        consecutiveErrors++;
        const backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors - 1), 30000);
        console.error(`[FinanceWorker] 拉取异常 (连续错误次数: ${consecutiveErrors})，将在 ${backoffMs}ms 后重试: ${err.message}`);
        await this.sleep(backoffMs);
      }
    }

    console.log('[FinanceWorker] 守护工作进程已安全退出');
  }

  /**
   * 解密并规范化单条会话记录
   */
  private async processItem(item: EncryptedChatData): Promise<void> {
    const decrypted: DecryptedFinanceMessage = this.crypto.decrypt(item);

    // switch（切换企业）等事件没有 from 字段，不是聊天消息，直接跳过
    if (!decrypted.from) {
      console.log(`[FinanceWorker] 跳过无发送人的事件 (Seq=${item.seq}, MsgID=${decrypted.msgid}, 动作=${decrypted.action})`);
      return;
    }

    // 判断是否群聊以及是否外部群（外部群在企微中 roomid 通常非空）
    const isGroup = Boolean(decrypted.roomid);
    // 发送方如果是客户通常包含 wm/wo 前缀，或群 roomid 包含外部成员
    const isExternalCustomer = decrypted.from.startsWith('wm') || decrypted.from.startsWith('wo');
    const isExternalRoom = Boolean(isGroup && (decrypted.roomid?.startsWith('wr') || isExternalCustomer));

    const contentSummary = this.formatSummary(decrypted);

    // 格式化输出结构化日志
    console.log(
      `[FinanceWorker][收到全量消息] Seq=${item.seq} | ID=${decrypted.msgid} | ` +
      `房间=${decrypted.roomid || '(单聊)'} [${isExternalRoom ? '外部客户群' : isGroup ? '内部群' : '私聊'}] | ` +
      `发送人=${decrypted.from} | 类型=${decrypted.msgtype} | 动作=${decrypted.action} | 摘要: ${contentSummary}`
    );

    const event: InboundFinanceEvent = {
      seq: item.seq,
      msgid: decrypted.msgid,
      isExternalRoom,
      roomid: decrypted.roomid,
      sender: decrypted.from,
      timestamp: decrypted.msgtime,
      msgtype: decrypted.msgtype,
      contentSummary,
      payload: decrypted,
    };

    if (this.dispatcher) {
      await this.dispatcher.dispatch(event);
      console.log(`[FinanceWorker] 成功投递事件至 a3 (Seq=${item.seq}, MsgID=${decrypted.msgid})`);
    }

    if (this.messageHandler) {
      await this.messageHandler(event);
    }
  }

  /**
   * 提炼消息文本摘要
   */
  private formatSummary(msg: DecryptedFinanceMessage): string {
    switch (msg.msgtype) {
      case 'text':
        return msg.text?.content || '';
      case 'voice':
        return `[语音] 时长=${msg.voice?.play_length}s, 大小=${msg.voice?.voice_size}B`;
      case 'image':
        return `[图片] 大小=${msg.image?.filesize}B`;
      case 'video':
        return `[视频] 时长=${msg.video?.play_length}s, 大小=${msg.video?.filesize}B`;
      case 'file':
        return `[文件] 文件名=${msg.file?.filename}, 大小=${msg.file?.filesize}B`;
      case 'mixed':
        return `[图文混排] 共 ${msg.mixed?.item?.length || 0} 个子段`;
      default:
        return `[${msg.msgtype}] 原始数据`;
    }
  }

  /**
   * 优雅停止守护进程
   */
  public async stop(): Promise<void> {
    console.log('[FinanceWorker] 收到停机指令，正在优雅停止...');
    this.isRunning = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
