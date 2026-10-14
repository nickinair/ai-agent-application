/**
 * @file database.module.ts
 * @description 智能体全能平台 MySQL 数据库基础设施模块
 */

import { Global, Module } from '@nestjs/common';
import { MysqlService } from './mysql.service';
import { ENV, loadEnv } from '../config/env';

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }, MysqlService],
  exports: [MysqlService],
})
export class DatabaseModule {}
