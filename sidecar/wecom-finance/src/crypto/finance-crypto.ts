import * as crypto from 'crypto';
import { EncryptedChatData, DecryptedFinanceMessage } from '../types/finance.types';

export class FinanceCrypto {
  private rsaPrivateKey: string;
  private passphrase?: string;
  private nativeDecrypt?: (key: string, msg: string) => string;

  constructor(
    rsaPrivateKey: string,
    passphrase?: string,
    nativeDecrypt?: (key: string, msg: string) => string,
  ) {
    this.rsaPrivateKey = rsaPrivateKey;
    this.passphrase = passphrase;
    this.nativeDecrypt = nativeDecrypt;
  }

  /**
   * 使用企业 RSA 私钥解密 encrypt_random_key 得到 AES Key
   * @param encryptedRandomKeyBase64 Base64 编码的加密随机密钥
   */
  public decryptRandomKey(encryptedRandomKeyBase64: string): Buffer {
    const buffer = Buffer.from(encryptedRandomKeyBase64, 'base64');
    const privateKeyConfig: crypto.RsaPrivateKey = {
      key: this.rsaPrivateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    };
    if (this.passphrase) {
      privateKeyConfig.passphrase = this.passphrase;
    }

    try {
      const decrypted = crypto.privateDecrypt(privateKeyConfig, buffer);
      return decrypted;
    } catch (err: any) {
      throw new Error(`[FinanceCrypto] 解密随机密钥失败 (RSA Private Decrypt Failed): ${err.message}`);
    }
  }

  /**
   * 使用解密出的 AES Key 解密 encrypt_chat_msg
   * @param encryptedChatMsgBase64 Base64 编码的密文正文
   * @param aesKey 解密出的 AES Key
   */
  public decryptChatMsg(encryptedChatMsgBase64: string, aesKey: Buffer): DecryptedFinanceMessage {
    const cipherText = Buffer.from(encryptedChatMsgBase64, 'base64');
    
    // 企微会话存档协议：
    // 若 aesKey 为 16 字节使用 aes-128-cbc，若为 32 字节使用 aes-256-cbc
    // IV 为 aesKey 的前 16 字节（企微官方标准实现规范）
    const algorithm = aesKey.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
    const iv = aesKey.subarray(0, 16);

    try {
      const decipher = crypto.createDecipheriv(algorithm, aesKey, iv);
      // Node crypto 默认开启 PKCS7 padding
      decipher.setAutoPadding(true);
      
      const decrypted = Buffer.concat([
        decipher.update(cipherText),
        decipher.final(),
      ]);

      const jsonStr = decrypted.toString('utf8');
      return JSON.parse(jsonStr) as DecryptedFinanceMessage;
    } catch (err: any) {
      throw new Error(`[FinanceCrypto] 解密聊天消息正文失败 (AES Decrypt Failed): ${err.message}`);
    }
  }

  /**
   * 一站式解密单条企微存档数据
   */
  public decrypt(item: EncryptedChatData): DecryptedFinanceMessage {
    const randomKeyBuf = this.decryptRandomKey(item.encrypt_random_key);

    // 如果注册了官方 C-SDK 的 nativeDecrypt，直接调用企微原生 DecryptData
    if (this.nativeDecrypt) {
      const keyStr = randomKeyBuf.toString('utf8');
      const jsonStr = this.nativeDecrypt(keyStr, item.encrypt_chat_msg);
      return JSON.parse(jsonStr) as DecryptedFinanceMessage;
    }

    // 否则降级使用纯 JS AES-CBC 解密 (用于单元测试和 Mock 模式)
    return this.decryptChatMsg(item.encrypt_chat_msg, randomKeyBuf);
  }

  /**
   * 工具辅助方法：用于测试或 Mock 模式中生成符合规范的加密载荷
   */
  public static encryptForTesting(
    message: DecryptedFinanceMessage,
    rsaPublicKeyPem: string,
    aesKeyLength: 16 | 32 = 32,
  ): { encrypt_random_key: string; encrypt_chat_msg: string; rawAesKey: Buffer } {
    const rawAesKey = crypto.randomBytes(aesKeyLength);
    const algorithm = aesKeyLength === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
    const iv = rawAesKey.subarray(0, 16);

    // 1. AES 加密正文
    const cipher = crypto.createCipheriv(algorithm, rawAesKey, iv);
    cipher.setAutoPadding(true);
    const encryptedMsgBuf = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(message), 'utf8')),
      cipher.final(),
    ]);
    const encrypt_chat_msg = encryptedMsgBuf.toString('base64');

    // 2. RSA 公钥加密 AES Key
    const encryptedKeyBuf = crypto.publicEncrypt(
      {
        key: rsaPublicKeyPem,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      rawAesKey,
    );
    const encrypt_random_key = encryptedKeyBuf.toString('base64');

    return {
      encrypt_random_key,
      encrypt_chat_msg,
      rawAesKey,
    };
  }
}
