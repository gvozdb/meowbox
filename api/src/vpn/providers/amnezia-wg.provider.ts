/**
 * AmneziaWG провайдер.
 *
 * Особенности:
 *   - peer keypair и PSK генерим на агенте (через `awg genkey/pubkey/genpsk`).
 *   - Аллокация IP — на API: VpnService.configBlob держит счётчик через
 *     перебор существующих creds (см. allocateNextIp).
 *
 * См. docs/specs/2026-05-09-vpn-management.md §8.
 */

import { Injectable } from '@nestjs/common';
import {
  VpnProtocol,
  VpnInstallOptions,
  VpnAmneziaWgServiceConfig,
  VpnAmneziaWgUserCreds,
  VpnUserCredsView,
  VpnServiceConfig,
  VpnUserCreds,
  DEFAULT_AMNEZIA_NETWORK,
  DEFAULT_AMNEZIA_DNS,
  DEFAULT_AMNEZIA_MTU,
} from '@meowbox/shared';
import { AgentRelayService } from '../../gateway/agent-relay.service';
import { VpnProvider, renderQrPng } from './vpn-provider.interface';

@Injectable()
export class AmneziaWgProvider implements VpnProvider {
  readonly protocol = VpnProtocol.AMNEZIA_WG;

  constructor(private readonly relay: AgentRelayService) {}

  async install(opts: VpnInstallOptions, serviceId: string): Promise<VpnServiceConfig> {
    const network = opts.network || DEFAULT_AMNEZIA_NETWORK;
    const dns = opts.dns?.length ? opts.dns : [...DEFAULT_AMNEZIA_DNS];
    const mtu = opts.mtu || DEFAULT_AMNEZIA_MTU;
    const r = await this.relay.emitToAgent<{ config: VpnAmneziaWgServiceConfig }>(
      'vpn:awg:install',
      { serviceId, port: opts.port, network, dns, mtu },
    );
    if (!r.success || !r.data) throw new Error(r.error || 'awg install failed');
    return r.data.config;
  }

  async uninstall(serviceId: string, port: number): Promise<void> {
    const r = await this.relay.emitToAgent('vpn:awg:uninstall', { serviceId, port });
    if (!r.success) throw new Error(r.error || 'awg uninstall failed');
  }

  async isActive(serviceId: string): Promise<boolean> {
    const r = await this.relay.emitToAgent<{ active: boolean }>('vpn:awg:status', { serviceId });
    return r.success && r.data?.active === true;
  }

  async start(serviceId: string): Promise<void> {
    const r = await this.relay.emitToAgent('vpn:awg:start', { serviceId });
    if (!r.success) throw new Error(r.error || 'start failed');
  }

  async stop(serviceId: string): Promise<void> {
    const r = await this.relay.emitToAgent('vpn:awg:stop', { serviceId });
    if (!r.success) throw new Error(r.error || 'stop failed');
  }

  async generateUserCreds(
    serviceConfig: VpnServiceConfig,
    allocatedIp?: string,
  ): Promise<VpnUserCreds> {
    if (serviceConfig.protocol !== VpnProtocol.AMNEZIA_WG) {
      throw new Error('protocol mismatch');
    }
    if (!allocatedIp) throw new Error('allocatedIp обязателен для AmneziaWG creds');
    const r = await this.relay.emitToAgent<{
      peerPriv: string;
      peerPub: string;
      peerPsk: string;
    }>('vpn:awg:gen-peer', {});
    if (!r.success || !r.data) throw new Error(r.error || 'gen-peer failed');
    return {
      protocol: VpnProtocol.AMNEZIA_WG,
      peerPriv: r.data.peerPriv,
      peerPub: r.data.peerPub,
      peerPsk: r.data.peerPsk,
      peerIp: allocatedIp,
    };
  }

  async applyAddUser(
    serviceId: string,
    _serviceConfig: VpnServiceConfig,
    creds: VpnUserCreds,
    name: string,
  ): Promise<void> {
    if (creds.protocol !== VpnProtocol.AMNEZIA_WG) throw new Error('protocol mismatch');
    const r = await this.relay.emitToAgent('vpn:awg:add-user', {
      serviceId,
      peerPub: creds.peerPub,
      peerPsk: creds.peerPsk,
      peerIp: creds.peerIp,
      name,
    });
    if (!r.success) throw new Error(r.error || 'add-user failed');
  }

  async applyRemoveUser(
    serviceId: string,
    _serviceConfig: VpnServiceConfig,
    creds: VpnUserCreds,
  ): Promise<void> {
    if (creds.protocol !== VpnProtocol.AMNEZIA_WG) throw new Error('protocol mismatch');
    const r = await this.relay.emitToAgent('vpn:awg:remove-user', {
      serviceId,
      peerPub: creds.peerPub,
    });
    if (!r.success) throw new Error(r.error || 'remove-user failed');
  }

  async renderUserView(
    serviceConfig: VpnServiceConfig,
    creds: VpnUserCreds,
    publicHost: string,
    port: number,
    userName: string,
  ): Promise<VpnUserCredsView> {
    if (
      serviceConfig.protocol !== VpnProtocol.AMNEZIA_WG ||
      creds.protocol !== VpnProtocol.AMNEZIA_WG
    ) {
      throw new Error('protocol mismatch');
    }
    const conf = buildWgQuickConfig({
      cfg: serviceConfig,
      creds,
      publicHost,
      port,
      label: userName,
    });
    const qr = await renderQrPng(conf);
    return { configUrl: conf, raw: conf, qrPng: qr };
  }

  async rotateKeys(serviceId: string): Promise<{ srvPriv: string; srvPub: string }> {
    const r = await this.relay.emitToAgent<{ srvPriv: string; srvPub: string }>(
      'vpn:awg:rotate-keys',
      { serviceId },
    );
    if (!r.success || !r.data) throw new Error(r.error || 'rotate-keys failed');
    return r.data;
  }
}

interface BuildWgParams {
  cfg: VpnAmneziaWgServiceConfig;
  creds: VpnAmneziaWgUserCreds;
  publicHost: string;
  port: number;
  label: string;
}

export function buildWgQuickConfig(p: BuildWgParams): string {
  const { cfg, creds } = p;
  return `# ${p.label}
[Interface]
PrivateKey = ${creds.peerPriv}
Address = ${creds.peerIp}/32
DNS = ${cfg.dns.join(', ')}
MTU = ${cfg.mtu}
Jc = ${cfg.jc}
Jmin = ${cfg.jmin}
Jmax = ${cfg.jmax}
S1 = ${cfg.s1}
S2 = ${cfg.s2}
H1 = ${cfg.h1}
H2 = ${cfg.h2}
H3 = ${cfg.h3}
H4 = ${cfg.h4}

[Peer]
PublicKey = ${cfg.srvPub}
PresharedKey = ${creds.peerPsk}
Endpoint = ${p.publicHost}:${p.port}
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`;
}

/** Считает следующий свободный IP-адрес в подсети сервиса по уже занятым. */
export function allocateNextIp(network: string, takenIps: string[]): string {
  // takenIps — это peer IPs (без serverIp .1).
  // Перебираем оффсеты с 2 (server занимает .1) и берём первый свободный.
  const taken = new Set(takenIps);
  for (let offset = 2; offset < 254; offset++) {
    const ip = ipPlus(network, offset);
    if (!taken.has(ip)) return ip;
  }
  throw new Error(`Подсеть ${network} переполнена (все .2..253 заняты)`);
}

function ipPlus(baseCidr: string, offset: number): string {
  const [base, prefixStr] = baseCidr.split('/');
  const prefix = Number(prefixStr);
  const parts = base.split('.').map(Number);
  const baseInt =
    ((parts[0] & 0xff) << 24) |
    ((parts[1] & 0xff) << 16) |
    ((parts[2] & 0xff) << 8) |
    (parts[3] & 0xff);
  const masked = baseInt & (~0 << (32 - prefix));
  const newInt = (masked + offset) >>> 0;
  return [
    (newInt >> 24) & 0xff,
    (newInt >> 16) & 0xff,
    (newInt >> 8) & 0xff,
    newInt & 0xff,
  ].join('.');
}
