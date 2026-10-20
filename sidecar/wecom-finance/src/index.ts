import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FinanceSidecarConfig } from './types/finance.types';
import { FinanceCrypto } from './crypto/finance-crypto';
import { SeqManager } from './cursor/seq-manager';
import { IFinanceDriver } from './driver/driver.interface';
import { MockDriver } from './driver/mock-driver';
import { NativeDriver } from './driver/native-driver';
import { HttpDispatcher } from './dispatcher/http-dispatcher';
import { GatewayClient } from './gateway/gateway-client';
import { FinanceWorker } from './worker/finance-worker';

/**
 * 解析并注入单个 .env 配置文件
 */
function parseEnvFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
    return true;
  } catch (err: any) {
    console.warn(`[Config] 读取配置文件失败 (${filePath}): ${err.message}`);
    return false;
  }
}

/**
 * 级联环境配置加载器
 * 支持 ENV_FILE -> .env.${NODE_ENV}.local -> .env.${NODE_ENV} -> .env.local -> .env
 */
function loadConfig(): FinanceSidecarConfig {
  const nodeEnv = process.env.NODE_ENV || 'dev';
  const candidateFiles: string[] = [];

  if (process.env.ENV_FILE) {
    candidateFiles.push(path.resolve(process.env.ENV_FILE));
  }

  candidateFiles.push(
    path.resolve(`.env.${nodeEnv}.local`),
    path.resolve(`.env.${nodeEnv}`),
    path.resolve('.env.local'),
    path.resolve('.env'),
  );

  const loadedFiles: string[] = [];
  for (const file of candidateFiles) {
    if (parseEnvFile(file)) {
      loadedFiles.push(path.basename(file));
    }
  }

  console.log(`[Config] 环境模式 NODE_ENV=${nodeEnv}，已级联加载配置文件: [${loadedFiles.join(', ') || '无外部文件'}]`);

  const driverMode = (process.env.FINANCE_DRIVER_MODE?.toLowerCase() === 'native' ? 'native' : 'mock') as 'mock' | 'native';

  let rsaPrivateKey = '';
  const rsaKeyPath = process.env.RSA_PRIVATE_KEY_PATH;
  if (rsaKeyPath && fs.existsSync(rsaKeyPath)) {
    rsaPrivateKey = fs.readFileSync(rsaKeyPath, 'utf8');
  }

  return {
    corpid: process.env.WECOM_CORPID || 'ww_mock_corp_id',
    secret: process.env.WECOM_CHATDATA_SECRET || 'mock_chatdata_secret',
    driverMode,
    rsaPrivateKey,
    rsaPrivateKeyPassphrase: process.env.RSA_PRIVATE_KEY_PASSPHRASE,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '1000', 10),
    batchSize: parseInt(process.env.BATCH_SIZE || '100', 10),
    cursorStoragePath: process.env.CURSOR_STORAGE_PATH || './data/seq.cursor',
    cSdkLibPath: process.env.WECOM_C_SDK_LIB_PATH,
    a3WebhookUrl: process.env.A3_WEBHOOK_URL,
    a3WebhookSecret: process.env.A3_WEBHOOK_SECRET,
    gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:3003',
    gatewayEnabled: process.env.GATEWAY_ENABLED !== 'false',
    gatewayServiceName: process.env.GATEWAY_SERVICE_NAME || 'wecom-finance',
    gatewayA3ServiceName: process.env.GATEWAY_A3_SERVICE_NAME || 'ai-agent-application',
    gatewayNamespace: process.env.GATEWAY_NAMESPACE || 'wecom-finance',
    gatewayHeartbeatIntervalMs: parseInt(process.env.GATEWAY_HEARTBEAT_INTERVAL_MS || '10000', 10),
    gatewayAuthToken: process.env.GATEWAY_AUTH_TOKEN,
  };
}

async function bootstrap() {
  console.log('========================================================');
  console.log(' 企业微信会话内容存档 (Finance SDK) 独立 Sidecar 正在启动');
  console.log('========================================================');

  const config = loadConfig();

  // 1. 初始化网关客户端 (SRF & CC)
  const gatewayClient = new GatewayClient({
    gatewayUrl: config.gatewayUrl,
    enabled: config.gatewayEnabled,
    serviceName: config.gatewayServiceName,
    a3ServiceName: config.gatewayA3ServiceName,
    namespace: config.gatewayNamespace,
    heartbeatIntervalMs: config.gatewayHeartbeatIntervalMs,
    authToken: config.gatewayAuthToken,
  });

  // 2. 从网关配置中心 (CC) 动态拉取配置并合并
  if (gatewayClient.isEnabled()) {
    try {
      const remote = await gatewayClient.fetchRemoteConfig();
      if (remote.pollIntervalMs !== undefined) config.pollIntervalMs = Number(remote.pollIntervalMs);
      if (remote.batchSize !== undefined) config.batchSize = Number(remote.batchSize);
      if (remote.corpid) config.corpid = String(remote.corpid);
      if (remote.secret) config.secret = String(remote.secret);
      if (remote.driverMode === 'mock' || remote.driverMode === 'native') config.driverMode = remote.driverMode;
      if (remote.a3WebhookUrl) config.a3WebhookUrl = String(remote.a3WebhookUrl);
      if (remote.a3WebhookSecret) config.a3WebhookSecret = String(remote.a3WebhookSecret);
    } catch (err: any) {
      console.warn(`[Bootstrap] 加载网关配置中心异常，继续使用本地配置: ${err.message}`);
    }

    // 3. 向网关注册中心 (SRF) 注册自身并开启心跳
    await gatewayClient.register();
    gatewayClient.startHeartbeat();
  }

  // 4. 构建支持动态发现 a3 地址的 HttpDispatcher
  const dispatcher = new HttpDispatcher({
    webhookUrl: config.a3WebhookUrl,
    urlResolver: async () => gatewayClient.discoverA3WebhookUrl(),
    secretToken: config.a3WebhookSecret,
  });

  let driver: IFinanceDriver;
  let rsaPrivateKeyPem = config.rsaPrivateKey;

  if (config.driverMode === 'mock') {
    let rsaPublicKeyPem = '';
    if (!rsaPrivateKeyPem) {
      console.log('[Bootstrap] 未指定 RSA 私钥，为 Mock 模式自动生成 2048 位开发密钥对...');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      rsaPublicKeyPem = publicKey;
      rsaPrivateKeyPem = privateKey;
    } else {
      // 从私钥派生公钥
      const pubKeyObj = crypto.createPublicKey(rsaPrivateKeyPem);
      rsaPublicKeyPem = pubKeyObj.export({ type: 'spki', format: 'pem' }) as string;
    }

    driver = new MockDriver({
      rsaPublicKeyPem,
      autoGenerate: true,
    });
  } else {
    if (!rsaPrivateKeyPem) {
      throw new Error('[Bootstrap] 生产 Native 模式下必须配置 RSA_PRIVATE_KEY_PATH');
    }
    driver = new NativeDriver({
      corpid: config.corpid,
      secret: config.secret,
      libPath: config.cSdkLibPath,
    });
  }

  await driver.init();

  const nativeDecrypt = config.driverMode === 'native' && typeof (driver as any).decryptData === 'function'
    ? (key: string, msg: string) => (driver as any).decryptData(key, msg)
    : undefined;

  const financeCrypto = new FinanceCrypto(rsaPrivateKeyPem, config.rsaPrivateKeyPassphrase, nativeDecrypt);
  const seqManager = new SeqManager(config.cursorStoragePath);

  const worker = new FinanceWorker(driver, financeCrypto, seqManager, config, undefined, dispatcher);

  // 绑定网关 CC 动态配置热更回调
  if (gatewayClient.isEnabled()) {
    gatewayClient.onConfigUpdate((remote) => {
      worker.updateConfig(remote);
    });
    gatewayClient.startConfigSubscriber(process.env.REDIS_URL);
  }

  // 优雅停机信号处理
  const shutdown = async (signal: string) => {
    console.log(`\n[Bootstrap] 收到 ${signal} 停机信号，开始执行优雅关机流程...`);
    gatewayClient.stopConfigSubscriber();
    gatewayClient.stopHeartbeat();
    await gatewayClient.deregister();
    await worker.stop();
    await driver.destroy();
    console.log('[Bootstrap] 资源释放完毕，进程正常退出。');
    process.exit(0);
  };


  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 启动主轮询循环
  await worker.start();
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('[Bootstrap] 启动异常崩溃:', err);
    process.exit(1);
  });
}
