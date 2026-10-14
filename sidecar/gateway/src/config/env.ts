import { z } from 'zod';

export const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3003),
  NODE_ENV: z.string().default('development'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().default(0),
  REGISTRY_TTL_SECONDS: z.coerce.number().int().default(30),
  GATEWAY_AUTH_TOKEN: z.string().optional(),
  IDENTITY_FETCH_TIMEOUT_MS: z.coerce.number().int().default(300),
  IDENTITY_CACHE_TTL_SECONDS: z.coerce.number().int().default(3600),
});

export type Env = z.infer<typeof EnvSchema>;

export const ENV = Symbol('ENV');

export function loadEnv(override?: Record<string, string | undefined>): Env {
  const parsed = EnvSchema.safeParse({ ...process.env, ...override });
  if (!parsed.success) {
    throw new Error(`[Gateway] 环境变量配置校验失败: ${JSON.stringify(parsed.error.format())}`);
  }
  return parsed.data;
}
