import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** 请求参数校验：不通过返回 400 并列出字段 */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.') || '参数'}：${i.message}`).join('；'));
  return r.data;
}
