/**
 * 登录失败限制：同一账号或同一 IP 连续失败 maxFailures 次后锁定 lockMs。
 * 单实例内存实现；agent-app 生产两台时各自计数，足以挡住暴力尝试。
 */
export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly lockMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** 返回剩余锁定毫秒数，0 表示可以尝试 */
  lockedFor(...keys: string[]): number {
    return Math.max(0, ...keys.map((k) => (this.failures.get(k)?.lockedUntil ?? 0) - this.now()));
  }

  fail(...keys: string[]): void {
    for (const k of keys) {
      const f = this.failures.get(k) ?? { count: 0, lockedUntil: 0 };
      f.count += 1;
      if (f.count >= this.maxFailures) {
        f.lockedUntil = this.now() + this.lockMs;
        f.count = 0;
      }
      this.failures.set(k, f);
    }
  }

  succeed(...keys: string[]): void {
    for (const k of keys) this.failures.delete(k);
  }
}
