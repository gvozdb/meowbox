import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseFederationOrigin } from '../federation/endpoint-normalizer';
import { FederationLocalEndpointService } from '../federation/federation-local-endpoint.service';

@Injectable()
export class PublicDeliveryOriginService {
  constructor(
    private readonly config: ConfigService,
    private readonly localEndpoints: FederationLocalEndpointService,
  ) {}

  browserPublicOrigin(): string {
    const claim = this.localEndpoints.getClaim();
    return claim.state === 'READY'
      ? claim.endpoints.browserPublicOrigin
      : this.configuredPanelOrigin();
  }

  directTransferOrigin(): string {
    const claim = this.localEndpoints.getClaim();
    return claim.state === 'READY'
      ? claim.endpoints.directTransferOrigin
      : this.configuredPanelOrigin();
  }

  private configuredPanelOrigin(): string {
    const domain = String(this.config.get('PANEL_DOMAIN', '')).trim().toLowerCase();
    const portRaw = String(this.config.get('PANEL_PORT', '11862')).trim();
    if (!domain || !/^\d{1,5}$/.test(portRaw)) this.unreachable();
    const port = Number(portRaw);
    if (port < 1 || port > 65535 || /[\/?#@]/.test(domain)) this.unreachable();
    const origin = `https://${domain}${port === 443 ? '' : `:${port}`}`;
    try {
      return parseFederationOrigin(origin).origin;
    } catch {
      return this.unreachable();
    }
  }

  private unreachable(): never {
    throw new ServiceUnavailableException('TARGET_BROWSER_UNREACHABLE');
  }
}
