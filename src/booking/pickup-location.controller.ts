import { Body, Controller, ForbiddenException, Get, Param, Put, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccessGuard, CurrentUser, type Identity } from '../security/identity.js';
import { invalidInput, objectInput, uuid } from './input.js';
import { conflict, lockReservation, notFound } from './lifecycle.js';

@Controller('v1/reservations/:id/pickup-location')
@UseGuards(AccessGuard)
export class PickupLocationController {
  constructor(private readonly db: DataSource) {}
  @Get()
  async read(@Param('id') rawId: string, @CurrentUser() user: Identity) {
    const [row] = await this.db.query<{ pickupLocation: string | null }[]>(
      'SELECT pickup_location AS "pickupLocation" FROM reservations WHERE id=$1 AND ($2::uuid IS NULL OR employee_id=$2)',
      [uuid(rawId), user.role === 'admin' ? null : user.id],
    );
    if (!row) throw notFound();
    return row;
  }

  @Put()
  async set(@Param('id') rawId: string, @CurrentUser() user: Identity, @Body() body: unknown) {
    if (user.role !== 'admin')
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Lab administrator required' });
    const id = uuid(rawId);
    const value = objectInput(body, ['pickupLocation']).pickupLocation;
    if (typeof value !== 'string') invalidInput();
    const pickupLocation = value.trim();
    if (!pickupLocation || [...pickupLocation].length > 120 || pickupLocation.includes('\0'))
      invalidInput();
    await this.db.transaction(async (tx) => {
      const reservation = await lockReservation(tx, id);
      const [handover] = await tx.query<{ id: string }[]>(
        'SELECT id FROM handovers WHERE reservation_id=$1',
        [id],
      );
      if (reservation.status !== 'confirmed' || handover)
        throw conflict(
          'PICKUP_LOCATION_LOCKED',
          'Location is only editable before checkout on a confirmed reservation',
        );
      await tx.query('UPDATE reservations SET pickup_location=$2 WHERE id=$1', [
        id,
        pickupLocation,
      ]);
    });
    return { pickupLocation };
  }
}
