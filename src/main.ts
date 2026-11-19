import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { parsePort } from './port.js';

async function bootstrap() {
  const port = parsePort(process.env.PORT);
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(port);
  console.log('Booking API ready:', await app.getUrl());
}
await bootstrap();
