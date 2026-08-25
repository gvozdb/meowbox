import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { FederationManifestAccessGuard } from './federation-manifest-access.guard';
import { FederationManifestService } from './federation-manifest.service';

@Controller('federation/v1')
export class FederationManifestController {
  constructor(private readonly manifest: FederationManifestService) {}

  @Get('manifest')
  @Public()
  @UseGuards(FederationManifestAccessGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  getManifest() {
    return this.manifest.manifest();
  }
}
