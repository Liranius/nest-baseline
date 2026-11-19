import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessGuard, CurrentUser, type Identity } from '../security/identity.js';
import { invalidInput, objectInput, timeWindow, uuid } from './input.js';
import { ReservationsService } from './reservations.service.js';

function requireEmployee(user: Identity) {
  if (user.role !== 'employee')
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Employee role required' });
}

@Controller('v1/reservations')
@UseGuards(AccessGuard)
export class ReservationsController {
  constructor(private readonly bookings: ReservationsService) {}

  @Post()
  create(
    @CurrentUser() user: Identity,
    @Headers('idempotency-key') key: unknown,
    @Body() value: unknown,
  ) {
    requireEmployee(user);
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) invalidInput();
    const body = objectInput(value, ['equipmentId', 'from', 'to']);
    const { from, to } = timeWindow(body.from, body.to);
    return this.bookings.create(user.id, uuid(body.equipmentId), from, to, key);
  }

  @Get(':id')
  read(@CurrentUser() user: Identity, @Param('id') id: string) {
    return this.bookings.read(user.id, uuid(id));
  }

  @Delete(':id')
  @HttpCode(204)
  async cancel(@CurrentUser() user: Identity, @Param('id') id: string) {
    requireEmployee(user);
    await this.bookings.cancel(user.id, uuid(id));
  }
}
