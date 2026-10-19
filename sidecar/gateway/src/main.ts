import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const logger = new Logger('A3GatewayBootstrap');
  const env = loadEnv();

  const app = await NestFactory.create(AppModule.forRoot());
  app.enableCors();

  const port = env.PORT || 3003;
  await app.listen(port);

  logger.log(`🚀 a3 专属内部微服务网关已成功启动，正在监听端口: ${port}`);
  logger.log(`👉 网关接口手册与用法中心: http://localhost:${port}/api`);
  logger.log(`👉 服务注册与发现中心: http://localhost:${port}/api/registry/services`);
  logger.log(`👉 动态配置中心: http://localhost:${port}/api/config/namespaces`);
  logger.log(`👉 健康检查: http://localhost:${port}/health`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[Gateway] 启动失败:', err);
  process.exit(1);
});
