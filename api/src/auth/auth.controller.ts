import { Controller, Post, Get, Put, Delete, Body, Req, Param, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RefreshTokenDto, UpdateProfileDto, DisableTotpDto } from './auth.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { extractClientIp } from '../common/http/client-ip';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @Throttle({ short: { ttl: 60000, limit: 5 } })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const ip = this.extractIp(req);
    const ua = (req.headers['user-agent'] as string) || '';
    const result = await this.authService.login(dto.username, dto.password, ip, ua);
    return { success: true, data: result };
  }

  @Public()
  @Post('refresh')
  @Throttle({ short: { ttl: 60000, limit: 10 } })
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    const ip = this.extractIp(req);
    const ua = (req.headers['user-agent'] as string) || '';
    const result = await this.authService.refreshTokens(dto.refreshToken, ip, ua);
    return { success: true, data: result };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@Body() dto: RefreshTokenDto) {
    await this.authService.logout(dto.refreshToken);
    return { success: true, data: null };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getProfile(@CurrentUser('sub') userId: string) {
    const result = await this.authService.getProfile(userId);
    return { success: true, data: result };
  }

  @UseGuards(JwtAuthGuard)
  @Put('me')
  async updateProfile(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    const result = await this.authService.updateProfile(userId, dto);
    return { success: true, data: result };
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/enable')
  @Throttle({ short: { ttl: 60000, limit: 5 } })
  async enableTotp(@CurrentUser('sub') userId: string) {
    const result = await this.authService.enableTotp(userId);
    return { success: true, data: result };
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/confirm')
  @Throttle({ short: { ttl: 60000, limit: 10 } })
  async confirmTotp(
    @CurrentUser('sub') userId: string,
    @Body('code') code: string,
  ) {
    await this.authService.confirmTotp(userId, code);
    return { success: true, message: '2FA enabled successfully' };
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/disable')
  @Throttle({ short: { ttl: 60000, limit: 5 } })
  async disableTotp(
    @CurrentUser('sub') userId: string,
    @Body() dto: DisableTotpDto,
  ) {
    await this.authService.disableTotp(userId, dto.code, dto.currentPassword);
    return { success: true, message: '2FA disabled successfully' };
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  async getSessions(@CurrentUser('sub') userId: string) {
    const sessions = await this.authService.getSessions(userId);
    return { success: true, data: sessions };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('sessions/all')
  async revokeAllSessions(
    @CurrentUser('sub') userId: string,
    @CurrentUser('sid') currentSid: string,
  ) {
    const result = await this.authService.revokeAllSessions(userId, currentSid);
    return { success: true, data: result };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:sessionId')
  async revokeSession(
    @CurrentUser('sub') userId: string,
    @Param('sessionId') sessionId: string,
  ) {
    await this.authService.revokeSession(userId, sessionId);
    return { success: true, data: null };
  }

  private extractIp(req: Request): string {
    return extractClientIp(req);
  }
}
