import {
  Body,
  Controller,
  Head,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { ConsumeAdminerHandoffDto } from './adminer-handoff.dto';
import { AdminerHandoffService } from './adminer-handoff.service';

@Controller('public/v1/adminer')
export class AdminerHandoffController {
  constructor(private readonly handoffs: AdminerHandoffService) {}

  @Head('probe')
  @Public()
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  probe(@Res({ passthrough: true }) response: Response): void {
    this.setPublicHeaders(response);
  }

  @Post('handoffs/:id/consume')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async consume(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConsumeAdminerHandoffDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const consumed = await this.handoffs.consume(id, dto.secret);
    this.setPublicHeaders(response);
    response.setHeader('Set-Cookie', consumed.cookieHeader);
    return { success: true, data: { expiresAt: consumed.expiresAt } };
  }

  private setPublicHeaders(response: Response): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('X-Robots-Tag', 'noindex,nofollow');
  }
}
