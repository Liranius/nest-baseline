import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { AccessGuard, CurrentUser, type Identity } from '../security/identity.js';
import { uuid } from '../booking/input.js';
import { Notifications } from './notifications.js';
function admin(user: Identity) {
  if (user.role !== 'admin')
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Lab administrator required' });
}
@Controller('v1')
@UseGuards(AccessGuard)
export class NotificationsController {
  constructor(private readonly notifications: Notifications) {}
  @Get('reservations/:id/notifications')
  list(@CurrentUser() user: Identity, @Param('id') id: string) {
    admin(user);
    return this.notifications.list(uuid(id));
  }
  @Post('notification-deliveries/:id/replay')
  @HttpCode(202)
  replay(@CurrentUser() user: Identity, @Param('id') id: string) {
    admin(user);
    return this.notifications.replay(id, user.id);
  }
}
