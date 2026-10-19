import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
import { loadConfigCenter } from './config/config-center';
import { assertApiSecrets, ENV, Env, initEnvFiles } from './config/env';

async function bootstrap() {
  // 先读本地 .env（拿到配置中心地址），再用配置中心的值覆盖，之后各模块 loadEnv 读到的就是合并后的配置
  initEnvFiles();
  await loadConfigCenter();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 在 Nginx / CLB 后面：只信任内网代理带来的 X-Forwarded-For，取到真实客户端 IP（登录失败锁定按 IP 计数）
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  assertApiSecrets(app.get<Env>(ENV));

  // 支持接收微信推送的 XML 报文正文为 text 字符串
  app.use(express.text({ type: ['text/xml', 'application/xml', 'text/plain', '*/xml'] }));

  // 健康检查、测试注入、企微事件回调不带管理 API 前缀（Nginx 把 /test/ 与 /api/wecom/ 转到这里）
  app.setGlobalPrefix('api/admin', {
    exclude: [
      'health',
      { path: 'test/inject', method: RequestMethod.POST },
      { path: 'test/conversations/:chatId/trace', method: RequestMethod.GET },
      { path: 'api/wecom/callback', method: RequestMethod.GET },
      { path: 'api/wecom/callback', method: RequestMethod.POST },
    ],
  });
  app.enableShutdownHooks();
  await app.listen(app.get<Env>(ENV).PORT);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
