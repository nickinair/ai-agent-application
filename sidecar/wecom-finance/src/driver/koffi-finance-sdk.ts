import * as fs from 'fs';
import * as path from 'path';
import { EncryptedChatData, FinanceChatDataResponse } from '../types/finance.types';

export interface KoffiFinanceSdkOptions {
  libPath: string;
  corpid: string;
  secret: string;
}

/**
 * 企微官方 C 动态库 (libWeWorkFinanceSdk_C.so) 的 koffi FFI 封装
 * 严格按照官方 WeWorkFinanceSdk_C.h 头文件声明映射 C 接口并负责 C 堆内存释放
 */
export class KoffiFinanceSdk {
  private libPath: string;
  private corpid: string;
  private secret: string;
  private sdkHandle: any = null;
  private koffiLib: any = null;

  // 映射的 C 原生函数句柄
  private fnNewSdk: any = null;
  private fnInit: any = null;
  private fnNewSlice: any = null;
  private fnFreeSlice: any = null;
  private fnGetSliceLen: any = null;
  private fnGetContentFromSlice: any = null;
  private fnGetChatData: any = null;
  private fnDecryptData: any = null;
  private fnDestroySdk: any = null;
  // 媒体拉取（GetMediaData 及 MediaData_t 访问器）
  private fnNewMediaData: any = null;
  private fnFreeMediaData: any = null;
  private fnGetOutIndexBuf: any = null;
  private fnGetData: any = null;
  private fnGetDataLen: any = null;
  private fnIsMediaDataFinish: any = null;
  private fnGetMediaData: any = null;
  private koffi: any = null;

  constructor(options: KoffiFinanceSdkOptions) {
    this.libPath = path.resolve(options.libPath);
    this.corpid = options.corpid;
    this.secret = options.secret;
  }

  /**
   * 加载 C 动态链接库并完成企微 SDK 实例初始化
   */
  public async init(): Promise<void> {
    if (!fs.existsSync(this.libPath)) {
      throw new Error(
        `[KoffiFinanceSdk] 找不到企微 C 动态链接库: ${this.libPath}。\n` +
        `请将官方 Linux 64位动态库 libWeWorkFinanceSdk_C.so 放置于指定目录，或在开发测试环境下使用 mock 模式。`
      );
    }

    // 动态加载 koffi
    let koffi: any;
    try {
      koffi = require('koffi');
    } catch (err: any) {
      throw new Error(`[KoffiFinanceSdk] 加载 koffi 模块失败: ${err.message}`);
    }

    try {
      this.koffiLib = koffi.load(this.libPath);

      this.fnNewSdk = this.koffiLib.func('NewSdk', 'void*', []);
      this.fnInit = this.koffiLib.func('Init', 'int', ['void*', 'str', 'str']);
      this.fnNewSlice = this.koffiLib.func('NewSlice', 'void*', []);
      this.fnFreeSlice = this.koffiLib.func('FreeSlice', 'void', ['void*']);
      this.fnGetSliceLen = this.koffiLib.func('GetSliceLen', 'int', ['void*']);
      this.fnGetContentFromSlice = this.koffiLib.func('GetContentFromSlice', 'str', ['void*']);
      this.fnGetChatData = this.koffiLib.func('GetChatData', 'int', [
        'void*',
        'uint64_t',
        'uint32_t',
        'str',
        'str',
        'int',
        'void*',
      ]);
      this.fnDecryptData = this.koffiLib.func('DecryptData', 'int', ['str', 'str', 'void*']);
      this.fnDestroySdk = this.koffiLib.func('DestroySdk', 'void', ['void*']);
      this.fnNewMediaData = this.koffiLib.func('NewMediaData', 'void*', []);
      this.fnFreeMediaData = this.koffiLib.func('FreeMediaData', 'void', ['void*']);
      this.fnGetOutIndexBuf = this.koffiLib.func('GetOutIndexBuf', 'str', ['void*']);
      this.fnGetData = this.koffiLib.func('GetData', 'void*', ['void*']);
      this.fnGetDataLen = this.koffiLib.func('GetDataLen', 'int', ['void*']);
      this.fnIsMediaDataFinish = this.koffiLib.func('IsMediaDataFinish', 'int', ['void*']);
      this.fnGetMediaData = this.koffiLib.func('GetMediaData', 'int', ['void*', 'str', 'str', 'str', 'str', 'int', 'void*']);
      this.koffi = koffi;

      // 1. 创建 SDK 句柄
      this.sdkHandle = this.fnNewSdk();
      if (!this.sdkHandle) {
        throw new Error('[KoffiFinanceSdk] NewSdk 调用返回空句柄');
      }

      // 2. 初始化鉴权
      const initCode = this.fnInit(this.sdkHandle, this.corpid, this.secret);
      if (initCode !== 0) {
        throw new Error(`[KoffiFinanceSdk] Init 鉴权失败，返回错误码: ${initCode}`);
      }

      console.log(`[KoffiFinanceSdk] 成功加载并初始化企微 C-SDK (lib=${this.libPath}, corpid=${this.corpid})`);
    } catch (err: any) {
      this.destroy();
      throw new Error(`[KoffiFinanceSdk] 初始化 C 动态库异常: ${err.message}`);
    }
  }

  /**
   * 调用 C 函数 GetChatData 拉取密文切片数据
   * @param seq 起始游标
   * @param limit 拉取上限条数
   * @param timeout 超时秒数
   */
  public getChatData(seq: number, limit: number, timeout: number = 5): EncryptedChatData[] {
    if (!this.sdkHandle) {
      throw new Error('[KoffiFinanceSdk] SDK 尚未初始化，请先调用 init()');
    }

    // 分配输出切片结构体指针
    const slice = this.fnNewSlice();
    if (!slice) {
      throw new Error('[KoffiFinanceSdk] NewSlice 返回空指针');
    }

    try {
      const ret = this.fnGetChatData(
        this.sdkHandle,
        BigInt(seq),
        limit,
        '', // proxy
        '', // passwd
        timeout,
        slice,
      );

      if (ret !== 0) {
        throw new Error(`GetChatData 失败，企微 C 接口返回码: ${ret}`);
      }

      const len = this.fnGetSliceLen(slice);
      if (len <= 0) {
        return [];
      }

      // 提取 C 缓冲区内的原始 JSON 字符串
      const jsonStr = this.fnGetContentFromSlice(slice);
      if (!jsonStr) {
        return [];
      }

      const parsed: FinanceChatDataResponse = JSON.parse(jsonStr);

      if (parsed.errcode !== 0) {
        throw new Error(`企微服务端返回业务错误: [${parsed.errcode}] ${parsed.errmsg}`);
      }

      return parsed.chatdata || [];
    } finally {
      // 无论成功还是异常，必须释放企微 C-SDK 切片内存
      if (slice && this.fnFreeSlice) {
        try {
          this.fnFreeSlice(slice);
        } catch (freeErr: any) {
          console.warn(`[KoffiFinanceSdk] 释放 C 切片内存警告: ${freeErr.message}`);
        }
      }
    }
  }

  /**
   * 调用 C 函数 DecryptData 解密聊天消息正文
   * @param encryptKey 解密后的随机密钥明文字符串
   * @param encryptChatMsg 密文正文
   */
  public decryptData(encryptKey: string, encryptChatMsg: string): string {
    if (!this.fnDecryptData) {
      throw new Error('[KoffiFinanceSdk] DecryptData 函数未初始化');
    }

    const slice = this.fnNewSlice();
    if (!slice) {
      throw new Error('[KoffiFinanceSdk] NewSlice 返回空指针');
    }

    try {
      const ret = this.fnDecryptData(encryptKey, encryptChatMsg, slice);
      if (ret !== 0) {
        throw new Error(`DecryptData 失败，企微 C 接口返回码: ${ret}`);
      }

      const jsonStr = this.fnGetContentFromSlice(slice);
      if (!jsonStr) {
        throw new Error('DecryptData 返回空明文');
      }

      return jsonStr;
    } finally {
      if (slice && this.fnFreeSlice) {
        try {
          this.fnFreeSlice(slice);
        } catch (freeErr: any) {
          console.warn(`[KoffiFinanceSdk] 释放 C 切片内存警告: ${freeErr.message}`);
        }
      }
    }
  }

  /**
   * 调用 C 函数 GetMediaData 按分片拉取媒体文件（官方示例：每片新建 MediaData_t，用 outindexbuf 续拉，直到 IsMediaDataFinish）
   * @param sdkfileid 消息体里的 sdkfileid
   * @param timeout 单片超时秒数
   * @param maxBytes 超过这个大小就放弃，避免大文件卡住拉取循环
   */
  public getMediaData(sdkfileid: string, timeout: number = 10, maxBytes: number = 20 * 1024 * 1024): Buffer {
    if (!this.sdkHandle || !this.fnGetMediaData) {
      throw new Error('[KoffiFinanceSdk] SDK 尚未初始化或不支持 GetMediaData');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let indexBuf = '';
    for (let round = 0; round < 1000; round++) {
      const media = this.fnNewMediaData();
      if (!media) throw new Error('[KoffiFinanceSdk] NewMediaData 返回空指针');
      try {
        const ret = this.fnGetMediaData(this.sdkHandle, indexBuf, sdkfileid, '', '', timeout, media);
        if (ret !== 0) throw new Error(`GetMediaData 失败，企微 C 接口返回码: ${ret}`);
        const len = this.fnGetDataLen(media);
        if (len > 0) {
          // 必须在 FreeMediaData 之前把 C 缓冲区拷贝成 JS Buffer
          const bytes = this.koffi.decode(this.fnGetData(media), 'uint8', len) as number[] | Uint8Array;
          const chunk = Buffer.from(bytes as Uint8Array);
          chunks.push(chunk);
          total += chunk.length;
          if (total > maxBytes) throw new Error(`媒体文件超过 ${maxBytes} 字节，放弃拉取`);
        }
        if (this.fnIsMediaDataFinish(media) === 1) return Buffer.concat(chunks, total);
        indexBuf = this.fnGetOutIndexBuf(media) || '';
      } finally {
        try {
          this.fnFreeMediaData(media);
        } catch (freeErr: any) {
          console.warn(`[KoffiFinanceSdk] 释放 MediaData 内存警告: ${freeErr.message}`);
        }
      }
    }
    throw new Error('GetMediaData 分片次数异常，已中止');
  }

  /**
   * 销毁并释放 C SDK 实例资源
   */
  public destroy(): void {
    if (this.sdkHandle && this.fnDestroySdk) {
      try {
        this.fnDestroySdk(this.sdkHandle);
        console.log('[KoffiFinanceSdk] 企微 C-SDK 句柄已销毁释放');
      } catch (err: any) {
        console.warn(`[KoffiFinanceSdk] 销毁句柄警告: ${err.message}`);
      }
      this.sdkHandle = null;
    }
  }
}
