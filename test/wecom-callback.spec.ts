/**
 * @file wecom-callback.spec.ts
 * @description 企业微信 Webhook 回调加解密与控制器单元测试
 */

import { WecomCrypto } from '../src/modules/wecom/crypto/wecom-crypto';
import { WecomCallbackController } from '../src/modules/wecom/wecom-callback.controller';
import type { Env } from '../src/config/env';

describe('企业微信接收事件服务器回调 (WecomCallback)', () => {
  const token = '4RP';
  const encodingAESKey = 'KLW9jBbvR3Jj1fC4Ujxr2KXeeHdeDMoli6nQZq2hEeq';
  const corpId = 'ww1234567890abcdef';

  describe('1. 企微加解密标准协议工具测试 (WecomCrypto)', () => {
    let crypto: WecomCrypto;

    beforeEach(() => {
      crypto = new WecomCrypto(token, encodingAESKey, corpId);
    });

    it('签名计算与校验 (getSignature / verifySignature)', () => {
      const timestamp = '1729000000';
      const nonce = 'random_nonce_123';
      const text = 'test_encrypt_payload';

      const signature = crypto.getSignature(timestamp, nonce, text);
      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(40); // SHA1 hex digest is 40 chars

      expect(crypto.verifySignature(signature, timestamp, nonce, text)).toBe(true);
      expect(crypto.verifySignature('wrong_signature', timestamp, nonce, text)).toBe(false);
    });

    it('消息对称加解密往返一致性 (encrypt / decrypt)', () => {
      const originalMessage = '<xml><ToUserName>Test</ToUserName><Content>你好企业微信</Content></xml>';

      const encrypted = crypto.encrypt(originalMessage);
      expect(typeof encrypted).toBe('string');
      expect(encrypted).not.toBe(originalMessage);

      const decrypted = crypto.decrypt(encrypted);
      expect(decrypted.message).toBe(originalMessage);
      expect(decrypted.receiveId).toBe(corpId);
    });

    it('模拟首次 URL 校验 GET echostr 解密 (verifyAndDecryptEchoStr)', () => {
      const rawEcho = 'echostr_verification_token_999';
      const timestamp = '1729000001';
      const nonce = 'nonce_echo_456';

      const encryptedEcho = crypto.encrypt(rawEcho);
      const signature = crypto.getSignature(timestamp, nonce, encryptedEcho);

      const verifiedPlain = crypto.verifyAndDecryptEchoStr(
        signature,
        timestamp,
        nonce,
        encryptedEcho,
      );
      expect(verifiedPlain).toBe(rawEcho);
    });

    it('模拟 POST 报文 XML 解密 (verifyAndDecryptXml)', () => {
      const xmlPayload = '<xml><MsgType>text</MsgType><Content>测试报文</Content></xml>';
      const timestamp = '1729000002';
      const nonce = 'nonce_xml_789';

      const encrypted = crypto.encrypt(xmlPayload);
      const signature = crypto.getSignature(timestamp, nonce, encrypted);

      const postBodyXml = `<xml><ToUserName><![CDATA[${corpId}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;

      const result = crypto.verifyAndDecryptXml(signature, timestamp, nonce, postBodyXml);
      expect(result).toBe(xmlPayload);
    });
  });

  describe('2. 控制器接口测试 (WecomCallbackController)', () => {
    let controller: WecomCallbackController;
    let mockInboundService: any;
    let crypto: WecomCrypto;

    const mockEnv: Partial<Env> = {
      WECOM_CALLBACK_TOKEN: token,
      WECOM_CALLBACK_AES_KEY: encodingAESKey,
      WECOM_CORPID: corpId,
      WECOM_TENANT_ID: 1,
    };

    beforeEach(() => {
      mockInboundService = {
        onInbound: jest.fn().mockResolvedValue({ status: 'PROCESSED' }),
      };
      crypto = new WecomCrypto(token, encodingAESKey, corpId);
      controller = new WecomCallbackController(mockEnv as Env, mockInboundService);
    });

    it('GET /api/wecom/callback 成功响应 URL 验证并回显解密 echostr', () => {
      const rawEcho = 'verify_success_code';
      const timestamp = '1729000003';
      const nonce = 'nonce_get_123';
      const encryptedEcho = crypto.encrypt(rawEcho);
      const signature = crypto.getSignature(timestamp, nonce, encryptedEcho);

      let sentBody = '';
      let statusCode = 0;
      let contentType = '';

      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        type: (t: string) => {
          contentType = t;
          return res;
        },
        send: (body: string) => {
          sentBody = body;
          return res;
        },
      };

      controller.verifyUrl(signature, timestamp, nonce, encryptedEcho, res);

      expect(statusCode).toBe(200);
      expect(contentType).toBe('text/plain');
      expect(sentBody).toBe(rawEcho);
    });

    it('POST /api/wecom/callback 成功解密并回 success；群消息由机器人长连接收，回调不重复进流水线', async () => {
      const xmlContent = `
        <xml>
          <ToUserName><![CDATA[${corpId}]]></ToUserName>
          <FromUserName><![CDATA[wm_customer_test]]></FromUserName>
          <CreateTime>1729000005</CreateTime>
          <MsgType><![CDATA[text]]></MsgType>
          <Content><![CDATA[请问延保怎么办理？]]></Content>
          <MsgId>msg_99887766</MsgId>
          <ChatId><![CDATA[wr_chat_group_1]]></ChatId>
        </xml>
      `;

      const timestamp = '1729000005';
      const nonce = 'nonce_post_456';
      const encrypted = crypto.encrypt(xmlContent);
      const signature = crypto.getSignature(timestamp, nonce, encrypted);

      const postXml = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;

      const req: any = { body: postXml };
      let sentStatus = 0;
      let sentBody = '';

      const res: any = {
        status: (code: number) => {
          sentStatus = code;
          return res;
        },
        type: () => res,
        send: (body: string) => {
          sentBody = body;
          return res;
        },
      };

      await controller.handleCallback(signature, timestamp, nonce, req, res);

      expect(sentStatus).toBe(200);
      expect(sentBody).toBe('success');
      expect(mockInboundService.onInbound).not.toHaveBeenCalled();
    });
  });
});
