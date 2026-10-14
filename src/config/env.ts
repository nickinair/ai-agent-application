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
  PORT: z.coerce.number().int().default(3002),
  /** 如 mysql://agent:agent@localhost:3306/agent_platform */
  MYSQL_URL: z.string().default('mysql://agent:agent@localhost:3306/agent_platform'),
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

export type Env = z.infer<typeof EnvSchema>;

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

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`环境变量校验失败：${parsed.error.message}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');


