import { Controller, ForbiddenException, Get, Param, Put, UseGuards } from '@nestjs/common';
import { AccessGuard, CurrentUser, type Identity } from '../security/identity.js';
import { uuid } from './input.js';
import { HandoversService } from './handovers.service.js';

function requireAdmin(user: Identity) {
  if (user.role !== 'admin')
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Lab administrator required' });
}

@Controller('v1/reservations/:id')
@UseGuards(AccessGuard)
export class HandoversController {
  constructor(private readonly handovers: HandoversService) {}

  @Put('checkout')
  checkout(@CurrentUser() user: Identity, @Param('id') id: string) {
    requireAdmin(user);
    return this.handovers.checkout(uuid(id), user.id);
  }

  @Put('return')
  receive(@CurrentUser() user: Identity, @Param('id') id: string) {
    requireAdmin(user);
    return this.handovers.receive(uuid(id), user.id);
  }

  @Get('handover')
  progress(@CurrentUser() user: Identity, @Param('id') id: string) {
    return this.handovers.progress(uuid(id), user.role === 'employee' ? user.id : undefined);
  }

  @Get('audit')
  audit(@CurrentUser() user: Identity, @Param('id') id: string) {
    requireAdmin(user);
    return this.handovers.audit(uuid(id));
  }
}
