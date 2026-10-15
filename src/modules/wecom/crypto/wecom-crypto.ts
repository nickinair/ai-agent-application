/**
 * @file wecom-crypto.ts
 * @description 企业微信接收消息与事件回调官方加解密工具（遵循 WXBizMsgCrypt 标准规范）
 * @reference 企业微信开发文档：https://developer.work.weixin.qq.com/document/path/90968
 */

import * as crypto from 'node:crypto';

export interface DecryptResult {
  message: string;
  receiveId: string;
}

export class WecomCrypto {
  private readonly token: string;
  private readonly aesKey: Buffer;
  private readonly iv: Buffer;
  private readonly receiveId?: string;

  /**
   * @param token 企业微信后台设置的 Token
   * @param encodingAESKey 企业微信后台设置的 43 位 EncodingAESKey
   * @param receiveId 企业 CorpID 或 应用 AgentId (可选，校验接收者)
   */
  constructor(token: string, encodingAESKey: string, receiveId?: string) {
    if (!token) throw new Error('WecomCrypto: Token 不能为空');
    if (!encodingAESKey || encodingAESKey.length !== 43) {
      throw new Error('WecomCrypto: EncodingAESKey 必须为 43 位 Base64 字符串');
    }

    this.token = token;
    this.aesKey = Buffer.from(`${encodingAESKey}=`, 'base64');
    if (this.aesKey.length !== 32) {
      throw new Error('WecomCrypto: EncodingAESKey Base64 解码后必须为 32 字节');
    }
    this.iv = this.aesKey.subarray(0, 16);
    this.receiveId = receiveId;
  }

  /**
   * 生成企微安全签名 (SHA1)
   */
  getSignature(timestamp: string, nonce: string, encryptOrEchostr: string): string {
    const raw = [this.token, timestamp, nonce, encryptOrEchostr].sort().join('');
    return crypto.createHash('sha1').update(raw).digest('hex');
  }

  /**
   * 校验签名合法性
   */
  verifySignature(msgSignature: string, timestamp: string, nonce: string, encryptOrEchostr: string): boolean {
    const calculated = this.getSignature(timestamp, nonce, encryptOrEchostr);
    return calculated === msgSignature;
  }

  /**
   * 解密密文 (AES-256-CBC + PKCS#7 拆包)
   */
  decrypt(encryptedBase64: string): DecryptResult {
    const cipherBuffer = Buffer.from(encryptedBase64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.iv);
    decipher.setAutoPadding(false);

    const decrypted = Buffer.concat([decipher.update(cipherBuffer), decipher.final()]);

    // 去除 PKCS#7 补位 (企微固定块大小 32 字节)
    const pad = decrypted[decrypted.length - 1];
    if (pad < 1 || pad > 32) {
      throw new Error(`WecomCrypto: 无效的 PKCS#7 填充字节 ${pad}`);
    }
    const unpadded = decrypted.subarray(0, decrypted.length - pad);

    // 协议格式: 16 字节随机串 + 4 字节网络字节序长度 + 消息体明文 + 接收者 ID (CorpID)
    if (unpadded.length < 20) {
      throw new Error('WecomCrypto: 解密产物长度不足 20 字节');
    }

    const msgLen = unpadded.readUInt32BE(16);
    const message = unpadded.subarray(20, 20 + msgLen).toString('utf8');
    const receiveId = unpadded.subarray(20 + msgLen).toString('utf8');

    if (this.receiveId && receiveId && this.receiveId !== receiveId) {
      throw new Error(`WecomCrypto: receiveId 校验不一致 (期望: ${this.receiveId}, 实际: ${receiveId})`);
    }

    return { message, receiveId };
  }

  /**
   * 加密明文 (AES-256-CBC + PKCS#7 打包)
   */
  encrypt(replyText: string): string {
    const random16 = crypto.randomBytes(16);
    const msgBuf = Buffer.from(replyText, 'utf8');
    const msgLenBuf = Buffer.alloc(4);
    msgLenBuf.writeUInt32BE(msgBuf.length, 0);
    const receiveIdBuf = Buffer.from(this.receiveId || '', 'utf8');

    const raw = Buffer.concat([random16, msgLenBuf, msgBuf, receiveIdBuf]);

    // PKCS#7 补位到 32 字节整倍数
    const padLen = 32 - (raw.length % 32);
    const padBuf = Buffer.alloc(padLen, padLen);
    const toEncrypt = Buffer.concat([raw, padBuf]);

    const cipher = crypto.createCipheriv('aes-256-cbc', this.aesKey, this.iv);
    cipher.setAutoPadding(false);

    return Buffer.concat([cipher.update(toEncrypt), cipher.final()]).toString('base64');
  }

  /**
   * 快捷方法：验证并解密企微后台首次 URL 验证请求 (GET) 中的 echostr
   */
  verifyAndDecryptEchoStr(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    echostr: string,
  ): string {
    if (!this.verifySignature(msgSignature, timestamp, nonce, echostr)) {
      throw new Error('WecomCrypto: GET URL 验签失败 (签名不匹配)');
    }
    const { message } = this.decrypt(echostr);
    return message;
  }

  /**
   * 快捷方法：验证并解密企微推送的事件/消息 XML 报文 (POST)
   */
  verifyAndDecryptXml(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    encryptedXmlPayload: string,
  ): string {
    // 从 XML 提取 <Encrypt><![CDATA[...]]></Encrypt> 或 <Encrypt>...</Encrypt>
    const match = /<Encrypt>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/Encrypt>/i.exec(encryptedXmlPayload);
    const encrypted = match ? match[1].trim() : encryptedXmlPayload.trim();

    if (!this.verifySignature(msgSignature, timestamp, nonce, encrypted)) {
      throw new Error('WecomCrypto: POST 消息验签失败 (签名不匹配)');
    }

    const { message } = this.decrypt(encrypted);
    return message;
  }
}
