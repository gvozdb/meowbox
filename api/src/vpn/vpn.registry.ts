import { Injectable } from '@nestjs/common';
import { VpnProtocol } from '@meowbox/shared';
import { VpnProvider } from './providers/vpn-provider.interface';
import { XrayRealityProvider } from './providers/xray-reality.provider';
import { AmneziaWgProvider } from './providers/amnezia-wg.provider';

@Injectable()
export class VpnRegistry {
  constructor(
    private readonly xrayReality: XrayRealityProvider,
    private readonly amneziaWg: AmneziaWgProvider,
  ) {}

  get(protocol: VpnProtocol | string): VpnProvider {
    switch (protocol) {
      case VpnProtocol.VLESS_REALITY:
        return this.xrayReality;
      case VpnProtocol.AMNEZIA_WG:
        return this.amneziaWg;
      default:
        throw new Error(`Unknown VPN protocol: ${protocol}`);
    }
  }

  list(): VpnProtocol[] {
    return [VpnProtocol.VLESS_REALITY, VpnProtocol.AMNEZIA_WG];
  }
}
