import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Module,
  Post,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NodeAdapter } from '@nestjs/platform-node';
import { VerifyWebhook, WebhooksModule } from '@nestjs/webhooks';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { parsePort } from '../port.js';
import { uuid, objectInput, timeWindow, instant } from '../booking/input.js';

const company = process.env.RECEIVER_COMPANY;
if (company !== 'A' && company !== 'B') throw new Error('Set RECEIVER_COMPANY to A or B');
const organizationId =
  company === 'A' ? '20000000-0000-4000-8000-000000000001' : '20000000-0000-4000-8000-000000000002';
const schema = company === 'A' ? 'company_a_receiver' : 'company_b_receiver';
const url = process.env.RECEIVER_DATABASE_URL;
if (!url) throw new Error('Set RECEIVER_DATABASE_URL');
const options = { type: 'postgres' as const, url, synchronize: false };

@Controller()
class Receiver {
  constructor(private readonly db: DataSource) {}
  @Post('webhook')
  @VerifyWebhook('booking')
  @HttpCode(204)
  async accept(@Body() value: unknown, @Headers('webhook-id') id: string) {
    const envelope = objectInput(value, ['type', 'timestamp', 'data']);
    const data = objectInput(envelope.data, [
      'eventId',
      'organizationId',
      'reservationId',
      'equipmentId',
      'from',
      'to',
      'occurredAt',
      'version',
    ]);
    if (data.organizationId !== organizationId) throw new ForbiddenException();
    const version = data.version;
    if (
      uuid(data.eventId) !== id ||
      (version !== 1 && version !== 2) ||
      envelope.type !== (version === 1 ? 'reservation.confirmed' : 'reservation.cancelled')
    )
      throw new BadRequestException();
    const reservationId = uuid(data.reservationId);
    uuid(data.equipmentId);
    timeWindow(data.from, data.to);
    instant(data.occurredAt);
    instant(envelope.timestamp);
    await this.db.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }[]>(
        `INSERT INTO ${schema}.inbox(id,reservation_id,version,payload)
        VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id`,
        [id, reservationId, version, JSON.stringify(value)],
      );
      if (!inserted.length) return;
      await tx.query(
        `INSERT INTO ${schema}.reservations AS current_state(reservation_id,version,status) VALUES($1,$2,$3)
        ON CONFLICT(reservation_id) DO UPDATE SET version=excluded.version,status=excluded.status
        WHERE current_state.version < excluded.version`,
        [reservationId, version, version === 1 ? 'confirmed' : 'cancelled'],
      );
    });
  }
}

if (process.argv[2] === 'migrate') {
  const db = await new DataSource(options).initialize();
  try {
    await db.transaction(async (tx) => {
      await tx.query(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE IF NOT EXISTS ${schema}.inbox(id uuid PRIMARY KEY,reservation_id uuid NOT NULL,version smallint NOT NULL,payload jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS ${schema}.reservations(reservation_id uuid PRIMARY KEY,version smallint NOT NULL,status text NOT NULL);
    `);
    });
  } finally {
    await db.destroy();
  }
} else {
  const secret = process.env.RECEIVER_SECRET;
  if (!secret) throw new Error('Set RECEIVER_SECRET');
  @Module({
    imports: [
      TypeOrmModule.forRoot(options),
      WebhooksModule.forRoot({
        outgoing: false,
        receivers: { booking: { scheme: 'standard', secret, dedupe: false } },
      }),
    ],
    controllers: [Receiver],
  })
  class ReceiverModule {}
  const app = await NestFactory.create(ReceiverModule, new NodeAdapter(), { rawBody: true });
  app.enableShutdownHooks();
  await app.listen(parsePort(process.env.PORT), '127.0.0.1');
  console.log('Notification receiver ready:', await app.getUrl());
}
