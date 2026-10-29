import * as path from 'path';
import { IFinanceDriver } from './driver.interface';
import { EncryptedChatData } from '../types/finance.types';
import { KoffiFinanceSdk } from './koffi-finance-sdk';

export interface NativeDriverOptions {
  corpid: string;
  secret: string;
  libPath?: string;
}

/**
 * 生产环境企微原生 C-SDK 驱动
 * 底层基于 koffi 高性能 FFI 桥接 libWeWorkFinanceSdk_C.so 动态链接库
 */
export class NativeDriver implements IFinanceDriver {
  private corpid: string;
  private secret: string;
  private libPath: string;
  private sdk: KoffiFinanceSdk | null = null;

  constructor(options: NativeDriverOptions) {
    this.corpid = options.corpid;
    this.secret = options.secret;
    this.libPath = options.libPath || process.env.WECOM_C_SDK_LIB_PATH || './lib/libWeWorkFinanceSdk_C.so';
  }

  public async init(): Promise<void> {
    const resolvedPath = path.resolve(this.libPath);
    this.sdk = new KoffiFinanceSdk({
      libPath: resolvedPath,
      corpid: this.corpid,
      secret: this.secret,
    });

    await this.sdk.init();
  }

  public async fetchChatData(seq: number, limit: number, timeout: number = 5): Promise<EncryptedChatData[]> {
    if (!this.sdk) {
      throw new Error('[NativeDriver] SDK 尚未初始化，请先调用 init()');
    }

    // 调用底层 C 函数并自动释放堆内存
    return this.sdk.getChatData(seq, limit, timeout);
  }

  public decryptData(encryptKey: string, encryptChatMsg: string): string {
    if (!this.sdk) {
      throw new Error('[NativeDriver] SDK 尚未初始化，请先调用 init()');
    }
    return this.sdk.decryptData(encryptKey, encryptChatMsg);
  }

  public async fetchMedia(sdkfileid: string, timeout: number = 10): Promise<Buffer> {
    if (!this.sdk) {
      throw new Error('[NativeDriver] SDK 尚未初始化，请先调用 init()');
    }
    return this.sdk.getMediaData(sdkfileid, timeout);
  }

  public async destroy(): Promise<void> {
    if (this.sdk) {
      this.sdk.destroy();
      this.sdk = null;
    }
  }
}
