import { z } from 'zod';

const EnvSchema = z
  .object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().default(3002),
    /** 如 mysql://agent:agent@localhost:3306/agent_platform */
    MYSQL_URL: z.string().default('mysql://agent:agent@localhost:3306/agent_platform'),
    /** 改成员角色、协作方白名单后通知核心服务丢弃缓存（ag:cfg:changed） */
    REDIS_URL: z.string().default('redis://localhost:6379'),
    /** 管理 API 的 JWT 签名密钥（§11.4）；生产环境必须配置且不少于 32 个字符 */
    JWT_SECRET: z.string().default('dev-only-secret-change-me-in-production!!'),
    /** 令牌有效期（秒），默认 8 小时 */
    JWT_TTL_SECONDS: z.coerce.number().int().positive().default(8 * 3600),
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`环境变量校验失败：${parsed.error.message}`);
  }
  return parsed.data;
}

/** 管理 API 启动时检查（迁移、命令行不需要 JWT，不做这项检查）：生产环境必须配置足够长的 JWT 密钥 */
export function assertApiSecrets(env: Env): void {
  if (env.NODE_ENV === 'production' && (env.JWT_SECRET.length < 32 || env.JWT_SECRET.startsWith('dev-only'))) {
    throw new Error('生产环境必须配置不少于 32 个字符的 JWT_SECRET');
  }
}

export const ENV = Symbol('ENV');
