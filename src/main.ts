import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { parsePort } from './port.js';

async function bootstrap() {
  const port = parsePort(process.env.PORT);
  const app = await NestFactory.create(AppModule);
  await app.listen(port);
}
await bootstrap();
