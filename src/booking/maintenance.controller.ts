import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccessGuard, CurrentUser, requireAdmin, type Identity } from '../security/identity.js';
import { objectInput, timeWindow, uuid } from './input.js';
import { notFound, rethrowSlotConflict } from './lifecycle.js';

@Controller('v1')
@UseGuards(AccessGuard)
export class MaintenanceController {
  constructor(private readonly db: DataSource) {}

  @Post('equipment/:id/maintenance-windows')
  async schedule(@CurrentUser() user: Identity, @Param('id') raw: string, @Body() body: unknown) {
    requireAdmin(user);
    const id = uuid(raw);
    const input = objectInput(body, ['from', 'to']);
    const { from, to } = timeWindow(input.from, input.to);
    try {
      const [created] = await this.db.transaction('READ COMMITTED', (tx) =>
        tx.query<{ id: string }[]>(
          `INSERT INTO maintenance_windows(equipment_id, starts_at, ends_at, created_by)
         SELECT id, $2, $3, $4 FROM equipment WHERE id = $1 RETURNING id`,
          [id, from, to, user.id],
        ),
      );
      if (!created) throw notFound();
      return created;
    } catch (error) {
      rethrowSlotConflict(error);
    }
  }

  @Get('equipment/:id/maintenance-windows')
  async list(
    @CurrentUser() user: Identity,
    @Param('id') raw: string,
    @Query('from') start: unknown,
    @Query('to') end: unknown,
  ) {
    requireAdmin(user);
    const id = uuid(raw);
    const { from, to } = timeWindow(start, end);
    const [device] = await this.db.query<{ id: string }[]>('SELECT id FROM equipment WHERE id=$1', [
      id,
    ]);
    if (!device) throw notFound();
    return this.db.query(
      `SELECT id, equipment_id AS "equipmentId", starts_at AS "from", ends_at AS "to",
              CASE WHEN cancelled_at IS NULL THEN 'scheduled' ELSE 'cancelled' END AS status,
              created_by AS "createdBy", created_at AS "createdAt",
              cancelled_by AS "cancelledBy", cancelled_at AS "cancelledAt"
       FROM maintenance_windows WHERE equipment_id=$1
         AND tstzrange(starts_at,ends_at,'[)') && tstzrange($2,$3,'[)')
       ORDER BY starts_at, created_at, id`,
      [id, from, to],
    );
  }

  @Delete('maintenance-windows/:id')
  @HttpCode(204)
  async cancel(@CurrentUser() user: Identity, @Param('id') raw: string) {
    requireAdmin(user);
    const id = uuid(raw);
    await this.db.transaction(async (tx) => {
      const [row] = await tx.query<{ cancelled_at: Date | null }[]>(
        'SELECT cancelled_at FROM maintenance_windows WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!row) throw notFound();
      if (row.cancelled_at === null)
        await tx.query(
          'UPDATE maintenance_windows SET cancelled_at=booking_now(), cancelled_by=$2 WHERE id=$1',
          [id, user.id],
        );
    });
  }
}
