// =============================================================================
// VPN Management — общие типы и enum'ы.
//
// Подробности — docs/specs/2026-05-09-vpn-management.md
// =============================================================================

/**
 * Поддерживаемые протоколы VPN.
 *
 * Архитектурно расширяемо: новый протокол = новый VpnProvider на агенте +
 * запись в registry на API + рендер формы в UI. Core менять не нужно.
 */
export enum VpnProtocol {
  /** VLESS + Reality поверх Xray-core (TCP). Primary, обход DPI/TSPU. */
  VLESS_REALITY = 'VLESS_REALITY',
  /** AmneziaWG — обфусцированный WireGuard от команды Amnezia (UDP). */
  AMNEZIA_WG = 'AMNEZIA_WG',
}

export enum VpnServiceStatus {
  RUNNING = 'RUNNING',
  STOPPED = 'STOPPED',
  ERROR = 'ERROR',
  DEPLOYING = 'DEPLOYING',
}

/** Опции, передаваемые при создании сервиса. */
export interface VpnInstallOptions {
  protocol: VpnProtocol;
  port: number;
  /** Произвольное имя сервиса для UI. */
  label?: string;
  // VLESS+Reality:
  sniMask?: string;
  // AmneziaWG:
  /** CIDR подсети, default '10.13.13.0/24'. */
  network?: string;
  /** Список DNS серверов, default ['1.1.1.1','8.8.8.8']. */
  dns?: string[];
  /** MTU, default 1280. */
  mtu?: number;
}

/**
 * Расшифрованные параметры сервиса VLESS+Reality.
 *
 * НЕ хранится в БД в plain виде — шифруется через api/common/crypto/vpn-cipher.
 */
export interface VpnRealityServiceConfig {
  protocol: VpnProtocol.VLESS_REALITY;
  /** xray x25519 private key (base64url). */
  privKey: string;
  /** xray x25519 public key (base64url). */
  pubKey: string;
  /** 8 hex chars. */
  shortId: string;
  /** Имя SNI-маски, например 'www.google.com'. */
  sniMask: string;
  /** uTLS fingerprint, default 'chrome'. */
  fingerprint: string;
}

/**
 * Расшифрованные параметры сервиса AmneziaWG.
 */
export interface VpnAmneziaWgServiceConfig {
  protocol: VpnProtocol.AMNEZIA_WG;
  /** WireGuard server private key (base64). */
  srvPriv: string;
  /** WireGuard server public key (base64). */
  srvPub: string;
  /** CIDR подсети, например '10.13.13.0/24'. */
  network: string;
  /** Серверный IP внутри подсети, например '10.13.13.1'. */
  serverIp: string;
  /** DNS-серверы для пушинга клиентам. */
  dns: string[];
  /** MTU. */
  mtu: number;
  /** Внешний интерфейс для MASQUERADE (eth0/ens3 и т.п.). */
  egressIface: string;
  /** Параметры обфускации AmneziaWG. */
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  h1: number;
  h2: number;
  h3: number;
  h4: number;
}

export type VpnServiceConfig =
  | VpnRealityServiceConfig
  | VpnAmneziaWgServiceConfig;

/** Креды одного юзера в одном VLESS+Reality сервисе. */
export interface VpnRealityUserCreds {
  protocol: VpnProtocol.VLESS_REALITY;
  /** UUID v4. */
  uuid: string;
  /** Flow для Vision, default 'xtls-rprx-vision'. */
  flow: string;
}

/** Креды одного юзера в одном AmneziaWG сервисе. */
export interface VpnAmneziaWgUserCreds {
  protocol: VpnProtocol.AMNEZIA_WG;
  /** WireGuard peer private key (base64). */
  peerPriv: string;
  /** WireGuard peer public key (base64). */
  peerPub: string;
  /** Pre-shared key (base64). */
  peerPsk: string;
  /** Выделенный IP внутри подсети (например '10.13.13.5'). */
  peerIp: string;
}

export type VpnUserCreds = VpnRealityUserCreds | VpnAmneziaWgUserCreds;

/** Результат addUser/getUserCreds — то, что показывается клиенту. */
export interface VpnUserCredsView {
  /** Готовый клиентский конфиг (vless:// URL или wg-quick текст). */
  configUrl: string;
  /** Plain conf (для AmneziaWG: wg-quick text; для VLESS: vless:// = configUrl). */
  raw: string;
  /** PNG QR base64-encoded. */
  qrPng: string;
}

/** Результат проверки SNI-маски. */
export interface SniValidationResult {
  ok: boolean;
  /** TLS-версия, например 'TLSv1.3'. */
  tlsVersion?: string;
  /** Группа, например 'X25519'. */
  group?: string;
  reason?: string;
}
