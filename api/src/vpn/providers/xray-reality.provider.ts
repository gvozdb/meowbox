/**
 * VLESS + Reality (Xray) провайдер на API-стороне.
 *
 * Тонкая обёртка: валидирует входные данные, шлёт RPC агенту,
 * рендерит vless:// URL для клиента + QR.
 *
 * См. docs/specs/2026-05-09-vpn-management.md §7.
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  VpnProtocol,
  VpnInstallOptions,
  VpnRealityServiceConfig,
  VpnRealityUserCreds,
  VpnUserCredsView,
  VpnServiceConfig,
  VpnUserCreds,
  DEFAULT_REALITY_FINGERPRINT,
  SniValidationResult,
} from '@meowbox/shared';
import { AgentRelayService } from '../../gateway/agent-relay.service';
import { VpnProvider, renderQrPng } from './vpn-provider.interface';

@Injectable()
export class XrayRealityProvider implements VpnProvider {
  readonly protocol = VpnProtocol.VLESS_REALITY;

  constructor(private readonly relay: AgentRelayService) {}

  async install(opts: VpnInstallOptions, serviceId: string): Promise<VpnServiceConfig> {
    if (!opts.sniMask) throw new Error('sniMask обязателен для VLESS+Reality');
    const result = await this.relay.emitToAgent<{ config: VpnRealityServiceConfig }>(
      'vpn:reality:install',
      { serviceId, port: opts.port, sniMask: opts.sniMask },
    );
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Agent install failed');
    }
    return result.data.config;
  }

  async uninstall(serviceId: string, port: number): Promise<void> {
    const r = await this.relay.emitToAgent('vpn:reality:uninstall', { serviceId, port });
    if (!r.success) throw new Error(r.error || 'uninstall failed');
  }

  async isActive(serviceId: string): Promise<boolean> {
    const r = await this.relay.emitToAgent<{ active: boolean }>('vpn:reality:status', { serviceId });
    return r.success && r.data?.active === true;
  }

  async start(serviceId: string): Promise<void> {
    const r = await this.relay.emitToAgent('vpn:reality:start', { serviceId });
    if (!r.success) throw new Error(r.error || 'start failed');
  }

  async stop(serviceId: string): Promise<void> {
    const r = await this.relay.emitToAgent('vpn:reality:stop', { serviceId });
    if (!r.success) throw new Error(r.error || 'stop failed');
  }

  async validateSni(sniMask: string): Promise<SniValidationResult> {
    const r = await this.relay.emitToAgent<SniValidationResult>(
      'vpn:reality:validate-sni',
      { sniMask },
    );
    if (!r.success || !r.data) {
      return { ok: false, reason: r.error || 'agent unreachable' };
    }
    return r.data;
  }

  async rotateSni(serviceId: string, newSni: string): Promise<void> {
    const r = await this.relay.emitToAgent('vpn:reality:rotate-sni', { serviceId, newSni });
    if (!r.success) throw new Error(r.error || 'rotate-sni failed');
  }

  async rotateKeys(
    serviceId: string,
  ): Promise<{ privKey: string; pubKey: string; shortId: string }> {
    const r = await this.relay.emitToAgent<{ privKey: string; pubKey: string; shortId: string }>(
      'vpn:reality:rotate-keys',
      { serviceId },
    );
    if (!r.success || !r.data) throw new Error(r.error || 'rotate-keys failed');
    return r.data;
  }

  async generateUserCreds(): Promise<VpnUserCreds> {
    return {
      protocol: VpnProtocol.VLESS_REALITY,
      uuid: randomUUID(),
      flow: 'xtls-rprx-vision',
    };
  }

  async applyAddUser(
    serviceId: string,
    _serviceConfig: VpnServiceConfig,
    creds: VpnUserCreds,
    name: string,
  ): Promise<void> {
    if (creds.protocol !== VpnProtocol.VLESS_REALITY) {
      throw new Error('protocol mismatch');
    }
    const r = await this.relay.emitToAgent('vpn:reality:add-user', {
      serviceId,
      uuid: creds.uuid,
      name,
    });
    if (!r.success) throw new Error(r.error || 'add-user failed');
  }

  async applyRemoveUser(
    serviceId: string,
    _serviceConfig: VpnServiceConfig,
    creds: VpnUserCreds,
  ): Promise<void> {
    if (creds.protocol !== VpnProtocol.VLESS_REALITY) {
      throw new Error('protocol mismatch');
    }
    const r = await this.relay.emitToAgent('vpn:reality:remove-user', {
      serviceId,
      uuid: creds.uuid,
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
      serviceConfig.protocol !== VpnProtocol.VLESS_REALITY ||
      creds.protocol !== VpnProtocol.VLESS_REALITY
    ) {
      throw new Error('protocol mismatch');
    }
    const url = buildVlessUrl({
      uuid: creds.uuid,
      host: publicHost,
      port,
      sniMask: serviceConfig.sniMask,
      pubKey: serviceConfig.pubKey,
      shortId: serviceConfig.shortId,
      fingerprint: serviceConfig.fingerprint || DEFAULT_REALITY_FINGERPRINT,
      flow: creds.flow || 'xtls-rprx-vision',
      label: userName,
    });
    const qr = await renderQrPng(url);
    return { configUrl: url, raw: url, qrPng: qr };
  }
}

interface BuildVlessParams {
  uuid: string;
  host: string;
  port: number;
  sniMask: string;
  pubKey: string;
  shortId: string;
  fingerprint: string;
  flow: string;
  label: string;
}

export function buildVlessUrl(p: BuildVlessParams): string {
  const params = new URLSearchParams({
    encryption: 'none',
    flow: p.flow,
    security: 'reality',
    sni: p.sniMask,
    fp: p.fingerprint,
    pbk: p.pubKey,
    sid: p.shortId,
    type: 'tcp',
    headerType: 'none',
  });
  // # часть URL = remarks/имя в клиенте
  const fragment = encodeURIComponent(p.label);
  return `vless://${p.uuid}@${p.host}:${p.port}?${params.toString()}#${fragment}`;
}
