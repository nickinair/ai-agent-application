import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { assertApiSecrets, ENV, Env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 在 Nginx / CLB 后面：只信任内网代理带来的 X-Forwarded-For，取到真实客户端 IP（登录失败锁定按 IP 计数）
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  assertApiSecrets(app.get<Env>(ENV));
  // 健康检查、测试注入不带管理 API 前缀（Nginx 把 /test/ 转到这里）
  app.setGlobalPrefix('api/admin', {
    exclude: ['health', { path: 'test/inject', method: RequestMethod.POST }, { path: 'test/conversations/:chatId/trace', method: RequestMethod.GET }],
  });
  app.enableShutdownHooks();
  await app.listen(app.get<Env>(ENV).PORT);
}

bootstrap();
