import type { MigrationInterface, QueryRunner } from 'typeorm';
import { PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { PostgresWebhookStore } from '@nestjs/webhooks/postgres';

export class BookingNotifications1795100000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(PostgresOutboxStore.migrationSql({ from: 0, to: 1 }));
    await q.query(PostgresWebhookStore.migrationSql({ from: 0, to: 1 }));
    await q.query(`
      CREATE UNIQUE INDEX booking_company_subscription ON nest_webhooks.endpoints(tenant) WHERE tenant IS NOT NULL;
      CREATE TABLE notification_events (
        id uuid PRIMARY KEY, reservation_id uuid NOT NULL REFERENCES reservations(id),
        organization_id uuid NOT NULL REFERENCES organizations(id),
        version smallint NOT NULL CHECK(version IN (1,2)), occurred_at timestamptz NOT NULL, queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(reservation_id,version)
      );
      CREATE TABLE notification_replays (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        delivery_id text NOT NULL REFERENCES nest_webhooks.deliveries(id), actor_id uuid NOT NULL REFERENCES accounts(id),
        replayed_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX notification_replays_by_delivery ON notification_replays(delivery_id,id);
    `);
  }
  async down(q: QueryRunner) {
    await q.query(`DROP TABLE notification_replays,notification_events;
      DROP TABLE nest_webhooks.delivery_attempts,nest_webhooks.deliveries,nest_webhooks.messages,nest_webhooks.endpoints,nest_webhooks.migrations;
      DROP SCHEMA nest_webhooks;
      DROP TABLE nest_outbox.messages,nest_outbox.dead_letters,nest_outbox.inbox,nest_outbox.migrations;
      DROP SCHEMA nest_outbox;`);
  }
}
