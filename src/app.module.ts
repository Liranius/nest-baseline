import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MaintenanceController } from './booking/maintenance.controller.js';
import { EquipmentController } from './booking/equipment.controller.js';
import { HandoversController } from './booking/handovers.controller.js';
import { HandoversService } from './booking/handovers.service.js';
import { ReservationsController } from './booking/reservations.controller.js';
import { ReservationsService } from './booking/reservations.service.js';
import { ApiErrorFilter } from './booking/api-error.filter.js';
import { APP_FILTER } from '@nestjs/core';
import { Account, Equipment } from './database/catalog.entity.js';
import { Reservation } from './database/reservation.entity.js';
import { databaseOptions } from './database/config.js';
import { AccessGuard, IdentityController } from './security/identity.js';

import { NotificationsModule } from './notifications/module.js';
import { NotificationsController } from './notifications/controller.js';

import { PickupLocationController } from './booking/pickup-location.controller.js';
import { ReadinessController } from './readiness.controller.js';

@Module({
  imports: [
    NotificationsModule.register(false),
    TypeOrmModule.forRootAsync({ useFactory: databaseOptions }),
    TypeOrmModule.forFeature([Account, Equipment, Reservation]),
    JwtModule.registerAsync({
      useFactory: () => {
        const secret = process.env.JWT_SECRET;
        if (!secret || Buffer.byteLength(secret) < 32)
          throw new Error('JWT_SECRET must contain at least 32 bytes');
        return {
          secret,
          signOptions: {
            expiresIn: 900,
            algorithm: 'HS256',
            issuer: 'equipment-booking-api',
            audience: 'booking-client',
          },
          verifyOptions: {
            algorithms: ['HS256'],
            issuer: 'equipment-booking-api',
            audience: 'booking-client',
          },
        };
      },
    }),
  ],
  controllers: [
    AppController,
    IdentityController,
    NotificationsController,
    PickupLocationController,
    ReadinessController,
    EquipmentController,
    MaintenanceController,
    ReservationsController,
    HandoversController,
  ],
  providers: [
    AppService,
    AccessGuard,
    ReservationsService,
    HandoversService,
    { provide: APP_FILTER, useClass: ApiErrorFilter },
  ],
})
export class AppModule {}
