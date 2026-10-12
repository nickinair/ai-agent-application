import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3002),
  /** 如 mysql://agent:agent@localhost:3306/agent_platform */
  MYSQL_URL: z.string().default('mysql://agent:agent@localhost:3306/agent_platform'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`环境变量校验失败：${parsed.error.message}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
