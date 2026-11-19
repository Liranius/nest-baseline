import { Module, type DynamicModule } from '@nestjs/common';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { PostgresOutboxStore, fromTypeOrm } from '@nestjs/outbox/postgres';
import { WebhooksModule, WebhooksStorage } from '@nestjs/webhooks';
import { PostgresWebhookStore } from '@nestjs/webhooks/postgres';
import { DataSource } from 'typeorm';
import { Notifications } from './notifications.js';

export const types = ['reservation.confirmed', 'reservation.cancelled'];

@Module({})
export class NotificationsModule {
  static register(worker: boolean): DynamicModule {
    return {
      module: NotificationsModule,
      imports: [
        OutboxModule.forRoot({ relay: { enabled: worker, pollInterval: 250 } }),
        WebhooksModule.forRootAsync({
          useFactory: () => {
            const key = process.env.NOTIFICATION_ENCRYPTION_KEY;
            if (!key || key.length < 32)
              throw new Error('NOTIFICATION_ENCRYPTION_KEY must contain at least 32 characters');
            return {
              eventTypes: types,
              encryption: { keys: [key] },
              retry: { attempts: 5, backoff: { delay: '1s', factor: 2, maxDelay: '30s' } },
              delivery: {
                allowHttp: process.env.NOTIFICATIONS_LOCAL === '1',
                allowedAddresses: process.env.NOTIFICATIONS_LOCAL === '1' ? ['127.0.0.1/32'] : [],
                timeout: '3s',
              },
              worker: { enabled: worker, pollInterval: 250, lease: '10s' },
            };
          },
        }),
      ],
      providers: [
        {
          provide: PostgresOutboxStore,
          inject: [DataSource, OutboxStorage],
          useFactory: (db: DataSource, store: OutboxStorage) =>
            new PostgresOutboxStore({ executor: fromTypeOrm(db), migrate: false }, store),
        },
        {
          provide: PostgresWebhookStore,
          inject: [DataSource, WebhooksStorage],
          useFactory: (db: DataSource, store: WebhooksStorage) =>
            new PostgresWebhookStore({ executor: fromTypeOrm(db), migrate: false }, store),
        },
        Notifications,
      ],
      exports: [Notifications],
    };
  }
}
