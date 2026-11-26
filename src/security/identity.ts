import {
  Body,
  CanActivate,
  Controller,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { IncomingMessage } from 'node:http';
import type { Repository } from 'typeorm';
import { Account } from '../database/catalog.entity.js';
import { invalidInput, objectInput } from '../booking/input.js';
import { matchesPassword } from './password.js';

export type Identity = Pick<Account, 'id' | 'login' | 'role' | 'organizationId'>;
export function requireAdmin(user: Identity) {
  if (user.role !== 'admin')
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Lab administrator required' });
}

interface AuthRequest extends IncomingMessage {
  principal: Identity;
}
const denied = () =>
  new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Valid credentials required' });
const identity = (account: Account): Identity => ({
  id: account.id,
  login: account.login,
  role: account.role,
  organizationId: account.organizationId,
});

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthRequest>().principal,
);

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly tokens: JwtService,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
  ) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw denied();
    let subject: string;
    try {
      const claims = await this.tokens.verifyAsync<{ sub: string; exp: number }>(token);
      if (typeof claims.sub !== 'string' || !Number.isFinite(claims.exp)) throw denied();
      subject = claims.sub;
    } catch {
      throw denied();
    }
    const account = await this.accounts.findOneBy({ id: subject });
    if (!account) throw denied();
    req.principal = identity(account);
    return true;
  }
}

@Controller('v1')
export class IdentityController {
  constructor(
    private readonly tokens: JwtService,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: unknown) {
    const { login, password } = objectInput(body, ['login', 'password']);
    if (
      typeof login !== 'string' ||
      !login ||
      login.length > 128 ||
      typeof password !== 'string' ||
      !password ||
      password.length > 256
    )
      invalidInput();
    const account = await this.accounts
      .createQueryBuilder('account')
      .addSelect('account.passwordHash')
      .where('account.login = :login', { login })
      .getOne();
    // Perform the same password derivation for an unknown login.
    const stored = account?.passwordHash ?? '0'.repeat(32) + ':' + '0'.repeat(128);
    if (!(await matchesPassword(password, stored)) || !account) throw denied();
    return {
      accessToken: await this.tokens.signAsync({ sub: account.id }),
      tokenType: 'Bearer',
      expiresIn: 900,
    };
  }

  @Get('me')
  @UseGuards(AccessGuard)
  me(@CurrentUser() user: Identity) {
    return user;
  }
}
