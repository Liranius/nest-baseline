import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { NodeAdapter, type NodeRequest, type NodeResponse } from '@nestjs/platform-node';
import { parsePort } from './port.js';

async function bootstrap() {
  const port = parsePort(process.env.PORT);
  const app = await NestFactory.create(AppModule, new NodeAdapter());
  // HAProxy can probe both releases with HEAD /. The prior release serves it after its startup checks.
  app.use((req: NodeRequest, _res: NodeResponse, next: () => void) => {
    if (req.method === 'HEAD' && req.url === '/') req.url = '/health/ready';
    next();
  });
  app.enableShutdownHooks();
  await app.listen(port);
  console.log('Booking API ready:', await app.getUrl());
}
await bootstrap();
