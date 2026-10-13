import { Body, Controller, Get, HttpCode, Ip, Post } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../admin/validation';
import { AuthService } from './auth.service';
import { Public, Tenant, TenantContext } from './tenant-context';

const LoginSchema = z.object({ tenantCode: z.string().min(1).max(32), username: z.string().min(1).max(64), password: z.string().min(1).max(128) });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Ip() ip: string) {
    const b = parse(LoginSchema, body);
    return this.auth.login(b.tenantCode, b.username, b.password, ip);
  }

  @Get('me')
  me(@Tenant() t: TenantContext) {
    return { ...t.user, actingTenantId: t.tenantId };
  }
}
