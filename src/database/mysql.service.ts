import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createPool, Pool } from 'mysql2/promise';
import { ENV, Env } from '../config/env';

/** 管理 API 用的连接池。P1-2 起按 §11.4 / §13.2 增加查询接口；仓储层第一个参数必须是 TenantContext。 */
@Injectable()
export class MysqlService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = createPool({ uri: env.MYSQL_URL, connectionLimit: 10 });
  }

  getPool(): Pool {
    return this.pool;
  }

  async ping(): Promise<boolean> {
    return this.pool.query('SELECT 1').then(() => true, () => false);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
