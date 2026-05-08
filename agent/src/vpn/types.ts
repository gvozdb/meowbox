/**
 * VPN agent types — это локальные типы агента. На API-стороне эти же
 * параметры приходят как payload через socket.io. Структуры зеркалят
 * shared/src/vpn-types.ts, но независимы — агент собирает себя без
 * прямой зависимости от @meowbox/shared (хотя могут импортироваться
 * через alias, как сделано для других модулей).
 *
 * См. docs/specs/2026-05-09-vpn-management.md.
 */

import type {
  VpnRealityServiceConfig,
  VpnAmneziaWgServiceConfig,
  VpnRealityUserCreds,
  VpnAmneziaWgUserCreds,
} from '@meowbox/shared';

export type {
  VpnRealityServiceConfig,
  VpnAmneziaWgServiceConfig,
  VpnRealityUserCreds,
  VpnAmneziaWgUserCreds,
};

export interface XrayInstallParams {
  serviceId: string;
  port: number;
  sniMask: string;
}

export interface XrayInstallResult {
  config: VpnRealityServiceConfig;
}

export interface XrayUserAddParams {
  serviceId: string;
  uuid: string;
  name: string;
}

export interface XrayUserRemoveParams {
  serviceId: string;
  uuid: string;
}

export interface AmneziaInstallParams {
  serviceId: string;
  port: number;
  network: string;
  dns: string[];
  mtu: number;
}

export interface AmneziaInstallResult {
  config: VpnAmneziaWgServiceConfig;
}

export interface AmneziaUserAddParams {
  serviceId: string;
  peerPub: string;
  peerPsk: string;
  peerIp: string;
  name: string;
}

export interface AmneziaUserRemoveParams {
  serviceId: string;
  peerPub: string;
}
