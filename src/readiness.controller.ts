import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Notifications } from './notifications/notifications.js';
import { PickupLocation1795200000000 } from './database/pickup-location.migration.js';

import { MaintenanceWindows1795300000000 } from './database/maintenance.migration.js';

@Controller('health')
export class ReadinessController {
  constructor(
    private readonly db: DataSource,
    private readonly notifications: Notifications,
  ) {}
  @Get('ready')
  async ready() {
    try {
      const rows = await this.db.query<{ id: number }[]>(
        'SELECT id FROM migrations WHERE name IN ($1,$2)',
        [PickupLocation1795200000000.name, MaintenanceWindows1795300000000.name],
      );
      if (rows.length !== 2) throw new Error('Missing required migration');
      await this.notifications.ensureSubscriptions();
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException({
        code: 'NOT_READY',
        message: 'Required database schema or subscriptions unavailable',
      });
    }
  }
}
