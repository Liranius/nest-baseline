import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { conflict, lockReservation, notFound, recordEvent, type Action } from './lifecycle.js';

interface Loan {
  id: string;
  checkedOutBy: string;
  checkedOutAt: Date;
  returnedBy: string | null;
  returnedAt: Date | null;
}
const columns =
  'h.id, h.checked_out_by AS "checkedOutBy", h.checked_out_at AS "checkedOutAt", h.returned_by AS "returnedBy", h.returned_at AS "returnedAt"';
const checkoutReceipt = (row: Loan) => ({
  handoverId: row.id,
  actorId: row.checkedOutBy,
  at: row.checkedOutAt,
});
const returnReceipt = (row: Loan) =>
  row.returnedAt && { handoverId: row.id, actorId: row.returnedBy, at: row.returnedAt };

async function lockDevice(tx: EntityManager, equipmentId: string) {
  await tx.query('SELECT id FROM equipment WHERE id=$1 FOR NO KEY UPDATE', [equipmentId]);
}
async function existingLoan(tx: EntityManager, reservationId: string) {
  const [loan] = await tx.query<Loan[]>(
    'SELECT ' + columns + ' FROM handovers h WHERE reservation_id=$1',
    [reservationId],
  );
  return loan;
}

@Injectable()
export class HandoversService {
  constructor(private readonly db: DataSource) {}

  async checkout(id: string, actorId: string) {
    return this.db.transaction(async (tx) => {
      const booking = await lockReservation(tx, id);
      await lockDevice(tx, booking.equipmentId);
      const prior = await existingLoan(tx, id);
      if (prior) return checkoutReceipt(prior);
      if (booking.status === 'cancelled')
        throw conflict('RESERVATION_CANCELLED', 'Reservation was cancelled');
      const [{ now }] = await tx.query<{ now: Date }[]>('SELECT booking_now() AS now');
      if (now < booking.from || now >= booking.to)
        throw conflict('OUTSIDE_PICKUP_WINDOW', 'Pickup requires an active reservation interval');
      const [row] = await tx.query<Loan[]>(
        `
        INSERT INTO handovers AS h (reservation_id,equipment_id,checked_out_by,checked_out_at)
        VALUES ($1,$2,$3,$4) ON CONFLICT (equipment_id) WHERE returned_at IS NULL DO NOTHING
        RETURNING ` + columns,
        [id, booking.equipmentId, actorId, now],
      );
      if (!row) throw conflict('EQUIPMENT_IN_USE', 'Equipment is still checked out');
      await recordEvent(tx, id, actorId, 'checked_out', row.checkedOutAt);
      return checkoutReceipt(row);
    });
  }

  async receive(id: string, actorId: string) {
    return this.db.transaction(async (tx) => {
      const booking = await lockReservation(tx, id);
      await lockDevice(tx, booking.equipmentId);
      const loan = await existingLoan(tx, id);
      if (!loan)
        throw conflict(
          'NOT_CHECKED_OUT',
          'Equipment has not been checked out for this reservation',
        );
      const prior = returnReceipt(loan);
      if (prior) return prior;
      // TypeORM returns [rows, affectedCount] for a PostgreSQL UPDATE with RETURNING.
      const [[receipt]] = await tx.query<
        [{ handoverId: string; at: Date; actorId: string }[], number]
      >(
        `
        UPDATE handovers SET returned_at=booking_now(), returned_by=$2 WHERE reservation_id=$1
        RETURNING id AS "handoverId", returned_at AS at, returned_by AS "actorId"`,
        [id, actorId],
      );
      await recordEvent(tx, id, actorId, 'returned', receipt.at);
      return receipt;
    });
  }

  async progress(id: string, employeeId?: string) {
    const [row] = await this.db.query<
      (Loan & {
        reservationId: string;
        equipmentId: string;
        reservationStatus: 'confirmed' | 'cancelled';
      })[]
    >(
      `
      SELECT r.id AS "reservationId", r.equipment_id AS "equipmentId", r.status AS "reservationStatus", ` +
        columns +
        `
      FROM reservations r LEFT JOIN handovers h ON h.reservation_id=r.id
      WHERE r.id=$1 AND ($2::uuid IS NULL OR r.employee_id=$2)`,
      [id, employeeId ?? null],
    );
    if (!row) throw notFound();
    const checkout = row.id ? checkoutReceipt(row) : null;
    const returned = returnReceipt(row);
    return {
      reservationId: row.reservationId,
      equipmentId: row.equipmentId,
      reservationStatus: row.reservationStatus,
      state: returned
        ? 'returned'
        : checkout
          ? 'checked_out'
          : row.reservationStatus === 'cancelled'
            ? 'cancelled'
            : 'pending',
      checkout,
      returned,
    };
  }

  async audit(id: string) {
    interface AuditRow {
      equipmentId: string;
      reservationStatus: 'confirmed' | 'cancelled';
      action: Action | null;
      from: string | null;
      to: string;
      actorId: string;
      at: Date;
    }
    const rows = await this.db.query<AuditRow[]>(
      `
      SELECT r.equipment_id AS "equipmentId", r.status AS "reservationStatus", e.action, e.actor_id AS "actorId", e.occurred_at AS at, e.from_state AS "from", e.to_state AS "to"
      FROM reservations r LEFT JOIN reservation_events e ON e.reservation_id=r.id WHERE r.id=$1 ORDER BY e.sequence`,
      [id],
    );
    if (!rows.length) throw notFound();
    const events = rows.flatMap(({ action, actorId, at, from, to }) => {
      if (!action) return [];
      return [{ action, actorId, at, from, to }];
    });
    return {
      reservationId: id,
      equipmentId: rows[0].equipmentId,
      reservationStatus: rows[0].reservationStatus,
      coverage: events[0]?.action === 'created' ? 'complete' : 'from_migration',
      events,
    };
  }
}
