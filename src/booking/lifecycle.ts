import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export interface Reservation {
  id: string;
  equipmentId: string;
  from: Date;
  to: Date;
  status: 'confirmed' | 'cancelled';
}
export const reservationFields =
  'id, equipment_id AS "equipmentId", starts_at AS "from", ends_at AS "to", status';

export const notFound = () =>
  new NotFoundException({ code: 'NOT_FOUND', message: 'Resource not found' });
export const conflict = (code: string, message: string) => new ConflictException({ code, message });

const transitions = {
  created: [null, 'confirmed'],
  cancelled: ['confirmed', 'cancelled'],
  checked_out: ['confirmed', 'checked_out'],
  returned: ['checked_out', 'returned'],
} as const;
export type Action = keyof typeof transitions;

export async function recordEvent(
  tx: EntityManager,
  reservationId: string,
  actorId: string,
  action: Action,
  at?: Date,
) {
  const [from, to] = transitions[action];
  await tx.query(
    'INSERT INTO reservation_events(reservation_id, actor_id, action, occurred_at, from_state, to_state) VALUES ($1,$2,$3,COALESCE($4,booking_now()),$5,$6)',
    [reservationId, actorId, action, at ?? null, from, to],
  );
}

// All transitions lock the reservation first. Physical handovers then lock its device.
export async function lockReservation(tx: EntityManager, id: string, employeeId?: string) {
  const [row] = await tx.query<Reservation[]>(
    `
    SELECT ${reservationFields}
    FROM reservations WHERE id=$1 AND ($2::uuid IS NULL OR employee_id=$2) FOR NO KEY UPDATE`,
    [id, employeeId ?? null],
  );
  if (!row) throw notFound();
  return row;
}
