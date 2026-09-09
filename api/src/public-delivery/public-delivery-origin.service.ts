import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseFederationOrigin } from '../federation/endpoint-normalizer';
import { FederationLocalEndpointService } from '../federation/federation-local-endpoint.service';
import { PanelSettingsService } from '../panel-settings/panel-settings.service';

@Injectable()
export class PublicDeliveryOriginService {
  constructor(
    private readonly config: ConfigService,
    private readonly localEndpoints: FederationLocalEndpointService,
    private readonly settings: PanelSettingsService,
  ) {}

  async browserPublicOrigin(): Promise<string> {
    const claim = this.localEndpoints.getClaim();
    return claim.state === 'READY'
      ? this.normalizeRecoveryOrigin(claim.endpoints.browserPublicOrigin)
      : this.currentPanelOrigin();
  }

  async directTransferOrigin(): Promise<string> {
    const claim = this.localEndpoints.getClaim();
    return claim.state === 'READY'
      ? this.normalizeRecoveryOrigin(claim.endpoints.directTransferOrigin)
      : this.currentPanelOrigin();
  }

  private async currentPanelOrigin(): Promise<string> {
    let activeOrigin: string | null;
    try {
      activeOrigin = await this.activeTlsPanelOrigin();
    } catch {
      return this.unreachable();
    }
    if (activeOrigin) return activeOrigin;

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

  private async normalizeRecoveryOrigin(claimedOrigin: string): Promise<string> {
    let activeOrigin: string | null;
    try {
      activeOrigin = await this.activeTlsPanelOrigin();
    } catch {
      return claimedOrigin;
    }
    if (!activeOrigin) return claimedOrigin;

    const portRaw = String(this.config.get('PANEL_PORT', '11862')).trim();
    if (!/^\d{1,5}$/.test(portRaw)) return claimedOrigin;
    const recoveryPort = Number(portRaw);
    if (recoveryPort < 1 || recoveryPort > 65535 || recoveryPort === 443) return claimedOrigin;

    const claimed = parseFederationOrigin(claimedOrigin);
    const active = parseFederationOrigin(activeOrigin);
    return claimed.hostname === active.hostname && claimed.port === recoveryPort
      ? active.origin
      : claimedOrigin;
  }

  private async activeTlsPanelOrigin(): Promise<string | null> {
    const access = await this.settings.getPanelAccess();
    const domain = (access.domain || '').trim().toLowerCase();
    return domain && access.certMode !== 'NONE'
      ? parseFederationOrigin(`https://${domain}`).origin
      : null;
  }

  private unreachable(): never {
    throw new ServiceUnavailableException('TARGET_BROWSER_UNREACHABLE');
  }
}
