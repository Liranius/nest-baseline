import { Injectable } from '@nestjs/common';
import { Webhooks } from '@nestjs/webhooks';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { conflict, notFound } from '../booking/lifecycle.js';

@Injectable()
export class Notifications {
  constructor(
    private readonly db: DataSource,
    private readonly sender: Webhooks<EntityManager>,
  ) {}
  async ensureSubscriptions() {
    const [{ ready }] = await this.db.query<{ ready: boolean }[]>(`
      SELECT count(*)=2 AS ready FROM organizations o JOIN nest_webhooks.endpoints e ON e.tenant=o.id::text
      WHERE o.name IN ('Company A','Company B') AND e.enabled`);
    if (!ready)
      throw new Error(
        'Missing active company subscriptions. Run db:seed and notifications:configure.',
      );
  }
  async enqueue(tx: EntityManager, reservationId: string, version: 1 | 2) {
    const eventId = randomUUID();
    const [data] = await tx.query<
      {
        eventId: string;
        reservationId: string;
        organizationId: string;
        equipmentId: string;
        from: Date;
        to: Date;
        occurredAt: Date;
        version: number;
      }[]
    >(
      `
      SELECT $2::uuid AS "eventId",r.id AS "reservationId",COALESCE(first_event.organization_id,a.organization_id) AS "organizationId",r.equipment_id AS "equipmentId",
        r.starts_at AS "from",r.ends_at AS "to",e.occurred_at AS "occurredAt",$3::int AS "version"
      FROM reservations r JOIN accounts a ON a.id=r.employee_id JOIN reservation_events e ON e.reservation_id=r.id
      LEFT JOIN notification_events first_event ON first_event.reservation_id=r.id AND first_event.version=1
      WHERE r.id=$1 AND e.action=$4`,
      [reservationId, eventId, version, version === 1 ? 'created' : 'cancelled'],
    );
    await tx.query(
      'INSERT INTO notification_events(id,reservation_id,organization_id,version,occurred_at) VALUES ($1,$2,$3,$4,$5)',
      [eventId, reservationId, data.organizationId, version, data.occurredAt],
    );
    await this.sender.dispatch(tx, {
      id: eventId,
      tenant: data.organizationId,
      type: version === 1 ? 'reservation.confirmed' : 'reservation.cancelled',
      data,
    });
  }

  async list(id: string) {
    const [row] = await this.db.query<{ events: unknown[] }[]>(
      `
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'eventId', n.id, 'organizationId', n.organization_id, 'version', n.version,
          'occurredAt', n.occurred_at, 'deliveryId', d.id,
          'status', COALESCE(d.status, CASE WHEN dead.id IS NOT NULL THEN 'relay_failed'
                                            WHEN fanout.id IS NOT NULL THEN 'unrouted' ELSE 'queued' END),
          'attempts', attempts.total, 'history', attempts.history,
          'lastError', COALESCE(d.last_error, attempts.latest_error, dead.last_error),
          'failureReason', COALESCE(d.failure_reason, CASE WHEN d.id IS NULL AND fanout.id IS NOT NULL THEN 'no-active-endpoint' END),
          'nextAttemptAt', to_timestamp(d.next_attempt_at / 1000.0), 'replays', replays.history
        ) ORDER BY n.version) FILTER (WHERE n.id IS NOT NULL), '[]') AS events
      FROM reservations r
      LEFT JOIN notification_events n ON n.reservation_id = r.id
      LEFT JOIN nest_webhooks.deliveries d ON d.message_id = n.id::text
      LEFT JOIN nest_webhooks.messages fanout ON fanout.id = n.id::text
      LEFT JOIN nest_outbox.dead_letters dead ON dead.id = n.id::text
      LEFT JOIN LATERAL (
        SELECT count(*) AS total, (array_agg(error ORDER BY seq DESC) FILTER (WHERE error IS NOT NULL))[1] AS latest_error,
          COALESCE(jsonb_agg(jsonb_build_object('attempt', attempt, 'at', to_timestamp(at / 1000.0),
            'statusCode', status_code, 'error', error) ORDER BY seq), '[]') AS history
        FROM nest_webhooks.delivery_attempts WHERE delivery_id = d.id
      ) attempts ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('actorId', actor_id, 'at', replayed_at) ORDER BY id), '[]') AS history
        FROM notification_replays WHERE delivery_id = d.id
      ) replays ON true
      WHERE r.id = $1 GROUP BY r.id`,
      [id],
    );
    if (!row) throw notFound();
    return row.events;
  }

  async replay(id: string, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query<{ status: string; reason: string | null }[]>(
        'SELECT status,failure_reason AS reason FROM nest_webhooks.deliveries WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!row) throw notFound();
      if (row.status !== 'failed' || row.reason !== 'exhausted')
        throw conflict('DELIVERY_NOT_EXHAUSTED', 'Only exhausted deliveries can be replayed');
      // Reset the official store's round and record the operator in the same transaction.
      await tx.query(
        `UPDATE nest_webhooks.deliveries SET status='pending', attempts=0, next_attempt_at=floor(extract(epoch FROM clock_timestamp())*1000),
        failure_reason=NULL,completed_at=NULL,lease_owner=NULL,lease_until=NULL WHERE id=$1`,
        [id],
      );
      await tx.query('INSERT INTO notification_replays(delivery_id,actor_id) VALUES ($1,$2)', [
        id,
        actorId,
      ]);
      return { deliveryId: id };
    });
  }

  async metrics() {
    const [row] = await this.db.query<
      { pending: number; oldestPendingMs: number; exhausted: number }[]
    >(`
      SELECT count(*) FILTER(WHERE pending)::int AS pending,
        COALESCE(floor(extract(epoch FROM clock_timestamp()-min(queued_at) FILTER(WHERE pending))*1000),0)::float8 AS "oldestPendingMs",
        count(*) FILTER(WHERE exhausted)::int AS exhausted
      FROM (SELECT n.queued_at,(d.status='pending' OR (d.id IS NULL AND dead.id IS NULL AND fanout.id IS NULL)) AS pending,
        d.failure_reason='exhausted' AS exhausted FROM notification_events n
        LEFT JOIN nest_webhooks.deliveries d ON d.message_id=n.id::text
        LEFT JOIN nest_webhooks.messages fanout ON fanout.id=n.id::text LEFT JOIN nest_outbox.dead_letters dead ON dead.id=n.id::text) states`);
    return row;
  }
}
