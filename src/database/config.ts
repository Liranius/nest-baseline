import type { DataSourceOptions } from 'typeorm';
import { Account, Equipment } from './catalog.entity.js';
import { BookingSchema1780000000000 } from './initial.migration.js';
import { EquipmentHandover1795000000000 } from './handover.migration.js';

export function databaseOptions(): DataSourceOptions {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return {
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    entities: [Account, Equipment],
    migrations: [BookingSchema1780000000000, EquipmentHandover1795000000000],
  };
}
