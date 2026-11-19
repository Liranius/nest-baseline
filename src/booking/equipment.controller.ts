import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Equipment } from '../database/catalog.entity.js';
import { AccessGuard } from '../security/identity.js';
import { timeWindow, uuid } from './input.js';

@Controller('v1/equipment')
@UseGuards(AccessGuard)
export class EquipmentController {
  constructor(
    @InjectRepository(Equipment) private readonly equipment: Repository<Equipment>,
    private readonly db: DataSource,
  ) {}

  @Get()
  list() {
    return this.equipment.find({ order: { id: 'ASC' } });
  }

  @Get(':id/availability')
  async availability(
    @Param('id') rawId: string,
    @Query('from') start: unknown,
    @Query('to') end: unknown,
  ) {
    const id = uuid(rawId);
    const { from, to } = timeWindow(start, end);
    if (!(await this.equipment.existsBy({ id })))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Equipment not found' });
    return this.db.query<{ from: Date; to: Date }[]>(
      `
      WITH requested AS (SELECT tstzrange($2::timestamptz,$3::timestamptz,'[)') AS span)
      SELECT lower(free) AS "from", upper(free) AS "to" FROM requested w
      CROSS JOIN LATERAL unnest(tstzmultirange(w.span) - COALESCE((
        SELECT range_agg(tstzrange(starts_at, ends_at,'[)')) FROM reservations
        WHERE equipment_id=$1 AND status='confirmed' AND tstzrange(starts_at, ends_at,'[)') && w.span
      ), '{}'::tstzmultirange)) AS free ORDER BY lower(free)`,
      [id, from, to],
    );
  }
}
