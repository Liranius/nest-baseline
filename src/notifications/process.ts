import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhooksEvents, WebhookEndpoints } from '@nestjs/webhooks';
import { DataSource } from 'typeorm';
import { databaseOptions } from '../database/config.js';
import { NotificationsModule, types } from './module.js';
import { Notifications } from './notifications.js';

const mode = process.argv[2];
if (mode !== 'worker' && mode !== 'configure') throw new Error('Expected worker or configure');
@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: databaseOptions }),
    NotificationsModule.register(mode === 'worker'),
  ],
})
class NotificationProcess {}
const app = await NestFactory.createApplicationContext(NotificationProcess);
try {
  if (mode === 'configure') {
    const endpoints = app.get(WebhookEndpoints);
    const db = app.get(DataSource);
    if (
      !process.env.WEBHOOK_SECRET_A ||
      process.env.WEBHOOK_SECRET_A === process.env.WEBHOOK_SECRET_B
    )
      throw new Error('Configure distinct company secrets');
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('configure booking subscriptions'))");
      for (const company of ['A', 'B']) {
        const [org] = await tx.query<{ id: string }[]>(
          'SELECT id FROM organizations WHERE name=$1',
          ['Company ' + company],
        );
        const url = process.env['WEBHOOK_URL_' + company],
          secret = process.env['WEBHOOK_SECRET_' + company];
        if (!org || !url || !secret)
          throw new Error('Missing organization or webhook configuration: ' + company);
        const [endpoint] = await endpoints.list({ tenant: org.id });
        if (!endpoint) await endpoints.create({ tenant: org.id, url, secret, eventTypes: types });
        else {
          if ((await endpoints.getSecret(endpoint.id)) !== secret)
            throw new Error('Configured secret differs for company ' + company);
          if (endpoint.url !== url || !endpoint.enabled)
            await endpoints.update(endpoint.id, { url, enabled: true });
        }
      }
    });
  } else {
    const notifications = app.get(Notifications);
    app.get(WebhooksEvents).events$.subscribe((event) => {
      if ('delivery' in event)
        console.log(
          JSON.stringify({
            kind: event.type,
            eventId: event.delivery.messageId,
            deliveryId: event.delivery.id,
            attempt: event.attempt,
          }),
        );
    });
    const report = async () =>
      console.log(
        JSON.stringify({ kind: 'notification_metrics', ...(await notifications.metrics()) }),
      );
    await report();
    const timer = setInterval(() => {
      report().catch(() => console.error('Notification metrics query failed'));
    }, 5000);

    console.log('Notification worker ready');
    // SIGTERM drains both pollers through the Nest application shutdown lifecycle.
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    clearInterval(timer);
  }
} finally {
  await app.close();
}
