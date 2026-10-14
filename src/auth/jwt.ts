import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { TokenClaims } from './tenant-context';

const ClaimsSchema = z.object({
  sub: z.number().int(),
  tenantId: z.number().int().nonnegative(),
  username: z.string(),
  role: z.enum(['platform_admin', 'tenant_admin', 'operator', 'labeler']),
});

export function signToken(claims: TokenClaims, secret: string, ttlSeconds: number): string {
  return jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: ttlSeconds, issuer: 'agent-app' });
}

/** 校验签名、算法、签发方与有效期；失败返回 null */
export function verifyToken(token: string, secret: string): TokenClaims | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'agent-app' });
    const r = ClaimsSchema.safeParse(payload);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
