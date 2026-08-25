import { Injectable, PayloadTooLargeException } from '@nestjs/common';
import {
  canonicalFederationJson,
  FEDERATED_VPN_FRAGMENT_MAX_BYTES,
  FEDERATED_VPN_FRAGMENT_MAX_ENTRIES,
  SignedFederatedVpnFragment,
  UnsignedFederatedVpnFragment,
  validateSignedFederatedVpnFragment,
} from '@meowbox/shared';
import { signFederationManifestPayload } from '../federation/federation-key-material';
import { PanelIdentityService } from '../federation/panel-identity.service';
import { FEDERATED_VPN_FRAGMENT_TTL_MS } from './federated-vpn.constants';
import { VpnService } from './vpn.service';

@Injectable()
export class FederatedVpnFragmentService {
  constructor(
    private readonly vpn: VpnService,
    private readonly panelIdentity: PanelIdentityService,
  ) {}

  async create(vpnUserId: string, now = new Date()): Promise<SignedFederatedVpnFragment> {
    const identity = await this.panelIdentity.getLocalIdentity();
    const source = await this.vpn.buildFederatedSubscriptionSource(vpnUserId);
    const contentBytes = source.entries.reduce(
      (total, entry) => total + Buffer.byteLength(entry.content, 'utf8'),
      0,
    );
    if (
      source.entries.length > FEDERATED_VPN_FRAGMENT_MAX_ENTRIES ||
      contentBytes > FEDERATED_VPN_FRAGMENT_MAX_BYTES
    ) throw new PayloadTooLargeException('VPN subscription source exceeds federation bounds');

    const unsigned: UnsignedFederatedVpnFragment = {
      schemaVersion: 1,
      targetInstallationId: identity.installationId,
      sourceId: source.sourceId,
      epoch: source.epoch,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + FEDERATED_VPN_FRAGMENT_TTL_MS).toISOString(),
      entries: source.entries,
    };
    return validateSignedFederatedVpnFragment({
      ...unsigned,
      signature: {
        algorithm: 'Ed25519',
        kid: identity.manifestKid,
        value: signFederationManifestPayload(
          Buffer.from(canonicalFederationJson(unsigned), 'utf8'),
          {
            installationId: identity.installationId,
            kid: identity.manifestKid,
            publicKeySpki: identity.manifestPublicKeySpki,
            encryptedPrivateKey: identity.manifestPrivateKeyEnc,
          },
        ),
      },
    });
  }
}
