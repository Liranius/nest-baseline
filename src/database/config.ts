import type { DataSourceOptions } from 'typeorm';
import { Account, Equipment } from './catalog.entity.js';
import { Reservation } from './reservation.entity.js';
import { BookingSchema1780000000000 } from './initial.migration.js';
import { EquipmentHandover1795000000000 } from './handover.migration.js';

import { BookingNotifications1795100000000 } from './notifications.migration.js';

import { PickupLocation1795200000000 } from './pickup-location.migration.js';

import { MaintenanceWindows1795300000000 } from './maintenance.migration.js';

export function databaseOptions(): DataSourceOptions {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return {
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    entities: [Account, Equipment, Reservation],
    migrations: [
      BookingSchema1780000000000,
      EquipmentHandover1795000000000,
      BookingNotifications1795100000000,
      PickupLocation1795200000000,
      MaintenanceWindows1795300000000,
    ],
  };
}
