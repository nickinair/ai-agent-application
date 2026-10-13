import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertApiSecrets, ENV, Env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  assertApiSecrets(app.get<Env>(ENV));
  app.setGlobalPrefix('api/admin', { exclude: ['health'] });
  app.enableShutdownHooks();
  await app.listen(app.get<Env>(ENV).PORT);
}

bootstrap();
