import {
  BadRequestException,
  Controller,
  Get,
  Head,
  Headers,
  HttpCode,
  Options,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { requireSingleRawHeader, setTransferCorsHeaders } from './transfer-http';
import { TransferSessionService } from './transfer-session.service';

@Controller('public/v1/transfers')
export class TransferController {
  constructor(private readonly sessions: TransferSessionService) {}

  @Head(':id/download')
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async head(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('secret') secret = '',
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.sessions.head(id, secret, response);
  }

  @Get(':id/download')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('secret') secret = '',
    @Headers('range') range: string | undefined,
    @Headers('if-range') ifRange: string | undefined,
    @Res({ passthrough: false }) response: Response,
  ): Promise<void> {
    await this.sessions.download(id, secret, range, ifRange, response);
  }

  @Put(':id/upload')
  @Public()
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async upload(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('secret') secret = '',
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const transferEncoding = requireSingleRawHeader(request, 'transfer-encoding');
    const contentEncoding = requireSingleRawHeader(request, 'content-encoding');
    if (transferEncoding) throw new BadRequestException('Chunked transfer encoding is not allowed');
    if (contentEncoding && contentEncoding.trim().toLowerCase() !== 'identity') {
      throw new BadRequestException('Compressed uploads are not allowed');
    }
    await this.sessions.upload(
      id,
      secret,
      requireSingleRawHeader(request, 'content-length'),
      requireSingleRawHeader(request, 'content-type'),
      request,
    );
    setTransferCorsHeaders(response);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }

  @Options(':id/upload')
  @Public()
  @HttpCode(204)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  preflight(@Res({ passthrough: true }) response: Response): void {
    setTransferCorsHeaders(response);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }
}
