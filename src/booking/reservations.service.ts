import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import {
  conflict,
  lockReservation,
  notFound,
  recordEvent,
  reservationFields,
  type Reservation,
} from './lifecycle.js';

@Injectable()
export class ReservationsService {
  constructor(private readonly db: DataSource) {}

  async create(employeeId: string, equipmentId: string, from: string, to: string, key: string) {
    try {
      return await this.db.transaction('READ COMMITTED', async (tx) => {
        // Serialize replays across instances. A rollback releases the key without retaining a result.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [
          employeeId + ':' + key,
        ]);
        const [existing] = await tx.query<Reservation[]>(
          'SELECT ' +
            reservationFields +
            ' FROM reservations WHERE employee_id=$1 AND idempotency_key=$2',
          [employeeId, key],
        );
        if (existing) {
          if (
            existing.equipmentId !== equipmentId ||
            existing.from.toISOString() !== from ||
            existing.to.toISOString() !== to
          )
            throw new ConflictException({
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'Key was used for a different reservation',
            });
          return { id: existing.id };
        }
        // One writer per device avoids competing GiST inserts. The exclusion constraint enforces occupancy.
        const equipment = await tx.query<{ id: string }[]>(
          'SELECT id FROM equipment WHERE id=$1 FOR NO KEY UPDATE',
          [equipmentId],
        );
        if (!equipment.length) throw notFound();
        const [created] = await tx.query<{ id: string }[]>(
          `
          INSERT INTO reservations(employee_id,equipment_id,starts_at,ends_at,idempotency_key)
          VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [employeeId, equipmentId, from, to, key],
        );
        await recordEvent(tx, created.id, employeeId, 'created');
        return created;
      });
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const cause = error.driverError as { code?: string; constraint?: string };
        if (cause.code === '23P01' && cause.constraint === 'equipment_slot_exclusion')
          throw new ConflictException({
            code: 'SLOT_CONFLICT',
            message: 'Equipment is already booked for this time',
          });
      }
      throw error;
    }
  }

  async read(employeeId: string, id: string) {
    const [reservation] = await this.db.query<Reservation[]>(
      'SELECT ' + reservationFields + ' FROM reservations WHERE employee_id=$1 AND id=$2',
      [employeeId, id],
    );
    if (!reservation) throw notFound();
    return reservation;
  }

  async cancel(employeeId: string, id: string) {
    await this.db.transaction(async (tx) => {
      const booking = await lockReservation(tx, id, employeeId);
      if (booking.status === 'cancelled') return;
      const loan = await tx.query<{ id: string }[]>(
        'SELECT id FROM handovers WHERE reservation_id=$1',
        [id],
      );
      if (loan.length)
        throw conflict('HANDOVER_EXISTS', 'A reservation with a handover cannot be cancelled');
      await tx.query("UPDATE reservations SET status='cancelled' WHERE id=$1", [id]);
      await recordEvent(tx, id, employeeId, 'cancelled');
    });
  }
}
