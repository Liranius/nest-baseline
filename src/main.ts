import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { Request, Response, NextFunction } from 'express';
import { parsePort } from './port.js';

async function bootstrap() {
  const port = parsePort(process.env.PORT);
  const app = await NestFactory.create(AppModule);
  // HAProxy can probe both releases with HEAD /. The prior release serves it after its startup checks.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.method === 'HEAD' && req.url === '/') req.url = '/health/ready';
    next();
  });
  app.enableShutdownHooks();
  await app.listen(port);
  console.log('Booking API ready:', await app.getUrl());
}
await bootstrap();
