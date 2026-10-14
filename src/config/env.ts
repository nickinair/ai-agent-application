import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const BooleanEnvSchema = z.preprocess((val) => {
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no') return false;
    if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'yes') return true;
  }
  return val;
}, z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(3002),
  /** 如 mysql://agent:agent@localhost:3306/agent_platform */
  MYSQL_URL: z.string().default('mysql://agent:agent@localhost:3306/agent_platform'),
  /** 改成员角色、协作方白名单后通知核心服务丢弃缓存（ag:cfg:changed） */
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** 测试注入接口（/test/inject 等，§13.1、评审 C6）：只在测试环境打开，生产必须为 false */
  TEST_INJECT_ENABLED: BooleanEnvSchema.default(false),
  /** 测试注入没带 tenantId 时用的租户 */
  TEST_TENANT_ID: z.coerce.number().int().positive().default(1),
  /** 管理 API 的 JWT 签名密钥（§11.4）；生产环境必须配置且不少于 32 个字符 */
  JWT_SECRET: z.string().default('dev-only-secret-change-me-in-production!!'),
  /** 令牌有效期（秒），默认 8 小时 */
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(8 * 3600),

  /** 企业微信智能机器人 Bot ID (可选，未配置时跳过长连接启动) */
  WECOM_BOT_ID: z.string().optional(),
  /** 企业微信智能机器人 Secret (可选，未配置时跳过长连接启动) */
  WECOM_BOT_SECRET: z.string().optional(),
  /** 企业微信智能机器人 WebSocket 网关，可选，默认官方 wss://openws.work.weixin.qq.com */
  WECOM_BOT_WS_URL: z.string().optional(),
  /** 企业微信机器人启用开关，默认为 true */
  WECOM_BOT_ENABLED: BooleanEnvSchema.default(true),
  /** 企业微信转人工时 @ 的客服人员标识（支持逗号隔开的 UserID 或默认 '@客服'） */
  WECOM_STAFF_MENTIONS: z.string().default('@客服'),
  /** 与会话内容存档 Sidecar 内部通信的鉴权 Token (可选) */
  WECOM_SIDECAR_TOKEN: z.string().optional(),

  // =========================================================================
  // Redis 与 BullMQ 队列基础设施配置（§7.1、§7.2）
  // =========================================================================
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().default(0),

  // =========================================================================
  // CRM 外部系统集成配置（§11.2）
  // =========================================================================
  CRM_BASE_URL: z.string().default('http://localhost:3001'),
  CRM_SERVICE_TOKEN: z.string().default('agent_dev_token_secret'),
  CRM_TIMEOUT_MS: z.coerce.number().int().default(800),

  // =========================================================================
  // 缓冲池与计时器流控参数（§5.3、§7.2）
  // =========================================================================
  /** 静默窗口（ms），默认 3000ms（3秒） */
  QUIET_WINDOW_MS: z.coerce.number().int().default(3000),
  /** 熔断窗口（ms），默认 15000ms（15秒） */
  HARD_TIMEOUT_MS: z.coerce.number().int().default(15000),
  /** 单组最大容纳客户消息数，达到立即封组，默认 5 条 */
  GROUP_MAX_MESSAGES: z.coerce.number().int().default(5),
  /** 普通会话空闲超时（ms），默认 30 分钟 (1800000ms) */
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().optional(),
  /** 完结收尾会话空闲超时（ms），默认 5 分钟 (300000ms) */
  CLOSE_IDLE_TIMEOUT_MS: z.coerce.number().int().optional(),

  // =========================================================================
  // 话筒机制与人机协同控制参数（§6.2、§11.3）
  // =========================================================================
  /** 员工抢话筒生效范围：ALL_INTERNAL (所有员工) 或 CS_ONLY (仅客服) */
  MIC_SEIZE_SCOPE: z.enum(['ALL_INTERNAL', 'CS_ONLY']).optional(),
  /** 客服 @机器人 是否交还话筒开关，默认 false（关闭） */
  MIC_RETURN_BY_MENTION_ENABLED: BooleanEnvSchema.optional(),
  /** 人工客服回复等待超时（ms），默认 60000ms（60秒自动接回） */
  HUMAN_WAIT_TIMEOUT_MS: z.coerce.number().int().optional(),
});

/** 管理 API 与配置通知用的字段（倪开）在类型上可选：运行时由 loadEnv 填默认值，单测手写的 Env 对象不必带上 */
type ApiEnvKeys = 'NODE_ENV' | 'REDIS_URL' | 'JWT_SECRET' | 'JWT_TTL_SECONDS' | 'TEST_INJECT_ENABLED' | 'TEST_TENANT_ID';
export type Env = Omit<z.infer<typeof EnvSchema>, ApiEnvKeys> & Partial<Pick<z.infer<typeof EnvSchema>, ApiEnvKeys>>;

let envFilesLoaded = false;

/**
 * 解析 .env 文件文本内容为键值对
 */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

/**
 * 按优先级加载环境配置文件（高优先级在前，已存在的环境变量不会被低优先级文件覆盖）：
 * 1. targetEnv.ENV_FILE（用户显式指定的配置文件）
 * 2. .env.${NODE_ENV}.local
 * 3. .env.local（本地开发私有配置，绝不提交）
 * 4. .env.${NODE_ENV}（如 .env.development）
 * 5. .env（默认基础配置）
 */
export function initEnvFiles(
  baseDir: string = process.cwd(),
  targetEnv: NodeJS.ProcessEnv = process.env,
): void {
  const nodeEnv = targetEnv.NODE_ENV;
  const candidates: string[] = [];

  if (targetEnv.ENV_FILE) {
    candidates.push(targetEnv.ENV_FILE);
  }

  if (nodeEnv) {
    candidates.push(`.env.${nodeEnv}.local`);
  }
  candidates.push('.env.local');

  if (nodeEnv) {
    candidates.push(`.env.${nodeEnv}`);
  }
  candidates.push('.env');

  for (const filename of candidates) {
    const fullPath = resolve(baseDir, filename);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf8');
        const parsed = parseEnvContent(content);
        for (const [k, v] of Object.entries(parsed)) {
          // 仅在环境变量尚未存在时设置（保证先加载的高优先级生效）
          if (targetEnv[k] === undefined) {
            targetEnv[k] = v;
          }
        }
      } catch {
        // 忽略解析异常
      }
    }
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (!envFilesLoaded && source === process.env) {
    initEnvFiles();
    envFilesLoaded = true;
  }

  const parsed = EnvSchema.safeParse(withRedisFromUrl(source));
  if (!parsed.success) {
    throw new Error(`环境变量校验失败：${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * 部署只配一个 REDIS_URL（与核心服务相同，两边必须连同一个 Redis 的同一个库）：
 * 没单独配 REDIS_HOST 时，从 REDIS_URL 拆出主机、端口、密码、库号给运行时的 Redis / BullMQ 用。
 */
export function withRedisFromUrl(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!source.REDIS_URL || source.REDIS_HOST) return source;
  const u = new URL(source.REDIS_URL);
  const db = u.pathname.replace(/^\//, '');
  return {
    ...source,
    REDIS_HOST: u.hostname,
    REDIS_PORT: u.port || '6379',
    ...(u.password ? { REDIS_PASSWORD: decodeURIComponent(u.password) } : {}),
    ...(db ? { REDIS_DB: db } : {}),
  };
}

/** 管理 API 启动时检查（迁移、命令行不需要 JWT，不做这项检查）：生产环境必须配置足够长的 JWT 密钥 */
export function assertApiSecrets(env: Env): void {
  const secret = env.JWT_SECRET ?? '';
  if (env.NODE_ENV === 'production' && (secret.length < 32 || secret.startsWith('dev-only'))) {
    throw new Error('生产环境必须配置不少于 32 个字符的 JWT_SECRET');
  }
}

/** JWT 签名密钥：loadEnv 总会给值；手写的 Env 缺这项时直接报错，不用空密钥签发或校验 */
export function jwtSecret(env: Env): string {
  if (!env.JWT_SECRET) throw new Error('未配置 JWT_SECRET');
  return env.JWT_SECRET;
}

export const ENV = Symbol('ENV');


