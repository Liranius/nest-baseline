import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { Reservation } from '../database/reservation.entity.js';
import { AccessGuard, CurrentUser, requireAdmin, type Identity } from '../security/identity.js';
import { invalidInput, objectInput, uuid } from './input.js';
import { conflict, lockReservation, notFound } from './lifecycle.js';

@Controller('v1/reservations/:id/pickup-location')
@UseGuards(AccessGuard)
export class PickupLocationController {
  constructor(
    @InjectRepository(Reservation) private readonly reservations: Repository<Reservation>,
    private readonly db: DataSource,
  ) {}
  @Get()
  async read(@Param('id') rawId: string, @CurrentUser() user: Identity) {
    const id = uuid(rawId);
    const reservation = await this.reservations.findOne({
      select: { id: true, pickupLocation: true },
      where: user.role === 'admin' ? { id } : { id, employeeId: user.id },
    });
    if (!reservation) throw notFound();
    return { pickupLocation: reservation.pickupLocation };
  }

  @Put()
  async set(@Param('id') rawId: string, @CurrentUser() user: Identity, @Body() body: unknown) {
    requireAdmin(user);
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
      await tx.getRepository(Reservation).update(id, { pickupLocation });
    });
    return { pickupLocation };
  }
}
