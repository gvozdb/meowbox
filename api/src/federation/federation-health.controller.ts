import { Controller, Get, Header } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { FederationManifestService } from './federation-manifest.service';

@Controller('federation/v1')
export class FederationHealthController {
  constructor(private readonly manifest: FederationManifestService) {}

  @Get('health')
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  health() {
    return this.manifest.health();
  }
}
