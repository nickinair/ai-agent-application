import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FinanceCrypto } from '../src/crypto/finance-crypto';
import { SeqManager } from '../src/cursor/seq-manager';
import { MockDriver } from '../src/driver/mock-driver';
import { FinanceWorker } from '../src/worker/finance-worker';
import { HttpDispatcher } from '../src/dispatcher/http-dispatcher';
import { KoffiFinanceSdk } from '../src/driver/koffi-finance-sdk';
import { DecryptedFinanceMessage, FinanceSidecarConfig, InboundFinanceEvent } from '../src/types/finance.types';

describe('企业微信会话内容存档 (Finance SDK) Sidecar 核心测试套件', () => {
  let rsaPublicKeyPem: string;
  let rsaPrivateKeyPem: string;
  const tempCursorPath = path.resolve(__dirname, './scratch_test_seq.cursor');

  beforeAll(() => {
    // 生成真实的 2048 位 RSA 测试密钥对
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    rsaPublicKeyPem = keyPair.publicKey;
    rsaPrivateKeyPem = keyPair.privateKey;
  });

  afterAll(() => {
    if (fs.existsSync(tempCursorPath)) {
      fs.unlinkSync(tempCursorPath);
    }
  });

  describe('1. 密码学解密 (FinanceCrypto)', () => {
    it('能够成功解密经过 RSA + AES-256-CBC 加密的文本消息', () => {
      const financeCrypto = new FinanceCrypto(rsaPrivateKeyPem);
      const originalMessage: DecryptedFinanceMessage = {
        msgid: 'MSG_TEST_001',
        action: 'send',
        from: 'wm_customer_888',
        tolist: ['internal_sales_666'],
        roomid: 'wr_ext_room_123',
        msgtime: 1718000000000,
        msgtype: 'text',
        text: { content: '你好，请问你们的智能客服收费标准是怎样的？' },
      };

      const encrypted = FinanceCrypto.encryptForTesting(originalMessage, rsaPublicKeyPem, 32);

      const decrypted = financeCrypto.decrypt({
        seq: 1,
        msgid: 'MSG_TEST_001',
        publickey_ver: 1,
        encrypt_random_key: encrypted.encrypt_random_key,
        encrypt_chat_msg: encrypted.encrypt_chat_msg,
      });

      expect(decrypted.msgid).toBe('MSG_TEST_001');
      expect(decrypted.from).toBe('wm_customer_888');
      expect(decrypted.roomid).toBe('wr_ext_room_123');
      expect(decrypted.msgtype).toBe('text');
      expect((decrypted as any).text.content).toBe('你好，请问你们的智能客服收费标准是怎样的？');
    });

    it('能够成功解密 16 字节 AES-128-CBC 密钥的语音消息', () => {
      const financeCrypto = new FinanceCrypto(rsaPrivateKeyPem);
      const originalVoice: DecryptedFinanceMessage = {
        msgid: 'MSG_VOICE_002',
        action: 'send',
        from: 'wm_customer_999',
        tolist: ['internal_sales_666'],
        roomid: 'wr_ext_room_123',
        msgtime: 1718000005000,
        msgtype: 'voice',
        voice: {
          voice_size: 2048,
          play_length: 3,
          sdkfileid: 'FILE_VOICE_TEST',
          md5sum: '1234567890abcdef',
        },
      };

      const encrypted = FinanceCrypto.encryptForTesting(originalVoice, rsaPublicKeyPem, 16);
      const decrypted = financeCrypto.decrypt({
        seq: 2,
        msgid: 'MSG_VOICE_002',
        publickey_ver: 1,
        encrypt_random_key: encrypted.encrypt_random_key,
        encrypt_chat_msg: encrypted.encrypt_chat_msg,
      });

      expect(decrypted.msgtype).toBe('voice');
      expect((decrypted as any).voice.play_length).toBe(3);
    });

    it('密文损坏时应抛出清晰的解密错误', () => {
      const financeCrypto = new FinanceCrypto(rsaPrivateKeyPem);
      expect(() => {
        financeCrypto.decryptRandomKey('invalid_base64_string!!!');
      }).toThrow(/解密随机密钥失败/);
    });
  });

  describe('2. 游标持久化管理 (SeqManager)', () => {
    it('支持初始化、原子持久化和断点恢复', () => {
      if (fs.existsSync(tempCursorPath)) {
        fs.unlinkSync(tempCursorPath);
      }

      const seqManager1 = new SeqManager(tempCursorPath);
      expect(seqManager1.getSeq()).toBe(0);

      seqManager1.updateSeq(100);
      expect(seqManager1.getSeq()).toBe(100);

      seqManager1.updateSeq(50);
      expect(seqManager1.getSeq()).toBe(100);

      const seqManager2 = new SeqManager(tempCursorPath);
      expect(seqManager2.getSeq()).toBe(100);

      seqManager2.updateSeq(250);
      expect(seqManager2.getSeq()).toBe(250);
    });
  });

  describe('3. Koffi 原生 SDK 封装保护 (KoffiFinanceSdk)', () => {
    it('在未找到 C 动态库时应抛出明确的业务引导异常', async () => {
      const sdk = new KoffiFinanceSdk({
        libPath: './non_existent_lib.so',
        corpid: 'ww_test',
        secret: 'sec_test',
      });

      await expect(sdk.init()).rejects.toThrow(/找不到企微 C 动态链接库/);
    });
  });

  describe('4. HTTP 事件分发投递器 (HttpDispatcher)', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('成功投递事件并正确携带 Token 与请求头', async () => {
      let interceptedHeaders: any = null;
      let interceptedBody: any = null;

      global.fetch = jest.fn().mockImplementation(async (url: any, init: any) => {
        interceptedHeaders = init.headers;
        interceptedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 0 }),
        } as any;
      });

      const dispatcher = new HttpDispatcher({
        webhookUrl: 'http://127.0.0.1:3002/api/admin/wecom/finance-inbound',
        secretToken: 'test_token_123',
      });

      const sampleEvent: InboundFinanceEvent = {
        seq: 10,
        msgid: 'MSG_DISPATCH_001',
        isExternalRoom: true,
        roomid: 'wr_ext_room_888',
        sender: 'wm_customer_1',
        timestamp: Date.now(),
        msgtype: 'text',
        contentSummary: '测试分发',
        payload: {
          msgid: 'MSG_DISPATCH_001',
          action: 'send',
          from: 'wm_customer_1',
          tolist: ['internal_sales_1'],
          roomid: 'wr_ext_room_888',
          msgtime: Date.now(),
          msgtype: 'text',
          text: { content: '测试分发' },
        },
      };

      const result = await dispatcher.dispatch(sampleEvent);
      expect(result).toBe(true);
      expect(interceptedHeaders['x-sidecar-token']).toBe('test_token_123');
      expect(interceptedBody.msgid).toBe('MSG_DISPATCH_001');
      expect(interceptedBody.isExternalRoom).toBe(true);
    });

    it('连续失败应触发重试并在最终失败时抛出异常', async () => {
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(async () => {
        callCount++;
        return {
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        } as any;
      });

      const dispatcher = new HttpDispatcher({
        webhookUrl: 'http://127.0.0.1:3002/api/admin/wecom/finance-inbound',
        maxRetries: 2,
      });

      const sampleEvent: InboundFinanceEvent = {
        seq: 11,
        msgid: 'MSG_FAIL_001',
        isExternalRoom: false,
        sender: 'user_1',
        timestamp: Date.now(),
        msgtype: 'text',
        contentSummary: '失败测试',
        payload: {} as any,
      };

      await expect(dispatcher.dispatch(sampleEvent)).rejects.toThrow(/投递事件给 a3 连续失败/);
      expect(callCount).toBe(2);
    });
  });

  describe('5. 驱动与守护工作流集成 (MockDriver & FinanceWorker)', () => {
    it('能够成功拉取、解密外部群全量消息并推进游标', async () => {
      const mockDriver = new MockDriver({
        rsaPublicKeyPem,
        autoGenerate: false,
      });
      await mockDriver.init();

      const financeCrypto = new FinanceCrypto(rsaPrivateKeyPem);
      const seqManager = new SeqManager(tempCursorPath);
      seqManager.reset(0);

      const receivedEvents: InboundFinanceEvent[] = [];

      const config: FinanceSidecarConfig = {
        corpid: 'ww_test_corp',
        secret: 'test_secret',
        driverMode: 'mock',
        rsaPrivateKey: rsaPrivateKeyPem,
        pollIntervalMs: 50,
        batchSize: 10,
        cursorStoragePath: tempCursorPath,
      };

      const worker = new FinanceWorker(
        mockDriver,
        financeCrypto,
        seqManager,
        config,
        (event) => {
          receivedEvents.push(event);
        },
      );

      const workerPromise = worker.start();
      await new Promise((r) => setTimeout(r, 200));

      expect(receivedEvents.length).toBeGreaterThanOrEqual(3);
      const extRoomMsg = receivedEvents.find((e) => e.roomid === 'wr_ext_room_998877');
      expect(extRoomMsg).toBeDefined();
      expect(extRoomMsg?.isExternalRoom).toBe(true);

      expect(seqManager.getSeq()).toBeGreaterThanOrEqual(3);

      await worker.stop();
      await mockDriver.destroy();
      await workerPromise;
    });
  });
});
