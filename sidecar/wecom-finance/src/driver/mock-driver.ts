import * as crypto from 'crypto';
import { IFinanceDriver } from './driver.interface';
import { EncryptedChatData, DecryptedFinanceMessage } from '../types/finance.types';
import { FinanceCrypto } from '../crypto/finance-crypto';

export interface MockDriverOptions {
  /** RSA 公钥 PEM 格式，用于模拟加密 */
  rsaPublicKeyPem: string;
  /** 是否周期性自动产生模拟数据 */
  autoGenerate?: boolean;
}

/**
 * 模拟模式驱动器：在本地开发或无 C 动态库环境下生成符合真实加解密规范的数据流
 */
export class MockDriver implements IFinanceDriver {
  private rsaPublicKeyPem: string;
  private messageQueue: EncryptedChatData[] = [];
  private currentSeq: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private autoGenerate: boolean;

  constructor(options: MockDriverOptions) {
    this.rsaPublicKeyPem = options.rsaPublicKeyPem;
    this.autoGenerate = options.autoGenerate ?? true;
  }

  public async init(): Promise<void> {
    // 预注入若干条初始消息（包含外部群未被 @ 的普通客户发言）
    this.enqueueSampleMessages();

    if (this.autoGenerate) {
      // 每 5 秒产生一条模拟外部群消息
      this.timer = setInterval(() => {
        this.generateRandomMockMessage();
      }, 5000);
    }
  }

  /**
   * 产生初始样本消息
   */
  private enqueueSampleMessages(): void {
    const samples: DecryptedFinanceMessage[] = [
      {
        msgid: `MOCK_${Date.now()}_001`,
        action: 'send',
        from: 'wm_customer_1001', // 外部客户
        tolist: ['internal_sales_001', 'robot_bot_001'],
        roomid: 'wr_ext_room_998877', // 外部客户群
        msgtime: Date.now() - 3000,
        msgtype: 'text',
        text: {
          content: '请问一下我们这个月续费的优惠政策是什么？（客户群内全量未@消息）',
        },
      },
      {
        msgid: `MOCK_${Date.now()}_002`,
        action: 'send',
        from: 'wm_customer_1002', // 另一位客户发送语音
        tolist: ['internal_sales_001'],
        roomid: 'wr_ext_room_998877',
        msgtime: Date.now() - 2000,
        msgtype: 'voice',
        voice: {
          voice_size: 10240,
          play_length: 5,
          sdkfileid: 'MOCK_SDK_FILE_VOICE_001',
          md5sum: 'abcdef1234567890',
        },
      },
      {
        msgid: `MOCK_${Date.now()}_003`,
        action: 'send',
        from: 'internal_user_001', // 内部单聊消息（非外部群）
        tolist: ['internal_user_002'],
        msgtime: Date.now() - 1000,
        msgtype: 'text',
        text: {
          content: '这是内部员工之间的私聊消息，下游应该做群聊范围过滤',
        },
      },
    ];

    for (const msg of samples) {
      this.pushMessage(msg);
    }
  }

  /**
   * 手动注入一条明文消息，自动用公钥加密入队（供单元测试和模拟器动态注入使用）
   */
  public pushMessage(msg: DecryptedFinanceMessage): number {
    this.currentSeq += 1;
    const encrypted = FinanceCrypto.encryptForTesting(msg, this.rsaPublicKeyPem, 32);

    const dataItem: EncryptedChatData = {
      seq: this.currentSeq,
      msgid: msg.msgid,
      publickey_ver: 1,
      encrypt_random_key: encrypted.encrypt_random_key,
      encrypt_chat_msg: encrypted.encrypt_chat_msg,
    };

    this.messageQueue.push(dataItem);
    return this.currentSeq;
  }

  /**
   * 自动生成随机外部客户群消息
   */
  private generateRandomMockMessage(): void {
    const randomTexts = [
      '发票什么时候能寄出？',
      '请问下系统支持手机端直接登录吗？',
      '刚才我测试了一下导出报表功能，挺流畅的！',
      '能发一份最新版本的操作指南 PDF 吗？',
    ];
    const text = randomTexts[Math.floor(Math.random() * randomTexts.length)];
    const msg: DecryptedFinanceMessage = {
      msgid: `MOCK_AUTO_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      action: 'send',
      from: `wm_cust_${Math.floor(Math.random() * 100)}`,
      tolist: ['sales_rep_01'],
      roomid: 'wr_ext_room_998877',
      msgtime: Date.now(),
      msgtype: 'text',
      text: { content: text },
    };
    this.pushMessage(msg);
  }

  public async fetchChatData(seq: number, limit: number): Promise<EncryptedChatData[]> {
    // 过滤出 seq > 传入游标的数据，且不超过 limit
    const unread = this.messageQueue.filter((item) => item.seq > seq);
    return unread.slice(0, limit);
  }

  public async destroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.messageQueue = [];
  }
}
