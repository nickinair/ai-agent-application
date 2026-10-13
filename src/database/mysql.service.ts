import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createPool, Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ENV, Env } from '../config/env';

/** 管理 API 用的连接池。所有查询都必须带上 tenant_id 条件（取自登录令牌，§10.3）。 */
@Injectable()
export class MysqlService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = createPool({ uri: env.MYSQL_URL, connectionLimit: 10 });
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows as unknown as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
    const [r] = await this.pool.query<ResultSetHeader>(sql, params);
    return r;
  }

  async ping(): Promise<boolean> {
    return this.pool.query('SELECT 1').then(() => true, () => false);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
