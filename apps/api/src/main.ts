import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { ErrorFilter } from './platform/errors';

async function bootstrap() {
  if (!process.env.JWT_ACCESS_SECRET) throw new Error('JWT_ACCESS_SECRET is required');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(helmet(), cookieParser());
  app.use((req: { headers: Record<string, unknown> }, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    const id = String(req.headers['x-request-id'] ?? randomUUID());
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    next();
  });
  app.useBodyParser('json', { limit: '5mb' });
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? '').split(','), credentials: true });
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('ERP API').addBearerAuth().build());
  SwaggerModule.setup('api/docs', app, doc);
  await app.listen(Number(process.env.PORT ?? 4000));
}
bootstrap();
