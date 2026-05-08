// =============================================================================
// VPN Management — дефолты, маски, ссылки на клиентов.
// =============================================================================

import { VpnProtocol } from './vpn-types';

/**
 * Список SNI-масок по умолчанию для VLESS+Reality.
 *
 * Каждая из них — реальный публичный сайт с TLS 1.3 + X25519 на 443/TCP.
 * При деплое сервиса агент валидирует выбранную маску через `openssl s_client`
 * — если её сейчас не отдают TLS 1.3 или нет X25519 в supported_groups,
 * деплой откатывается.
 *
 * Список периодически обновляем — некоторые сайты могут менять fingerprint
 * (напр. сменили ALPN или TLS-стек), их надо выкидывать.
 */
export const DEFAULT_SNI_MASKS: readonly string[] = [
  'www.google.com',
  'www.microsoft.com',
  'www.cloudflare.com',
  'addons.mozilla.org',
  'discord.com',
  'www.apple.com',
  'www.lovelive-anime.jp',
  'www.amazon.com',
];

export const DEFAULT_VPN_PORTS: Record<VpnProtocol, number> = {
  [VpnProtocol.VLESS_REALITY]: 443,
  [VpnProtocol.AMNEZIA_WG]: 51820,
};

export const DEFAULT_AMNEZIA_NETWORK = '10.13.13.0/24';
export const DEFAULT_AMNEZIA_DNS: readonly string[] = ['1.1.1.1', '8.8.8.8'];
export const DEFAULT_AMNEZIA_MTU = 1280;

/** uTLS fingerprint для VLESS-клиента, имитирующий Chrome. */
export const DEFAULT_REALITY_FINGERPRINT = 'chrome';

/** Базовый путь под все VPN-данные на сервере (state, не git). */
export const VPN_STATE_DIR = '/opt/meowbox/state/vpn';

/** Linux-юзер, под которым запускается xray-сервис (создаётся миграцией). */
export const VPN_RUNTIME_USER = 'meowbox-vpn';

/** Префикс systemd-юнита для xray. */
export const XRAY_SYSTEMD_PREFIX = 'meowbox-vpn-xray-';

/**
 * Префикс файла конфига AmneziaWG в /etc/amneziawg/
 * (имя интерфейса = `awg-<short8>`, ограничение Linux на длину IFNAMSIZ=15).
 */
export const AMNEZIAWG_IFACE_PREFIX = 'awg-';

/** Локация бинаря Xray (ставится миграцией install-xray). */
export const XRAY_BINARY_PATH = '/usr/local/bin/xray';

/**
 * Ссылки на клиенты VPN. Используется UI на странице юзера для подсказки.
 * Список сознательно короткий — не зоопарк, только бесплатное и проверенное.
 */
export const VPN_CLIENT_LINKS = {
  ios: {
    streisand: 'https://apps.apple.com/app/streisand/id6450534064',
    foxray: 'https://apps.apple.com/app/foxray/id6448898396',
    amnezia: 'https://apps.apple.com/app/amneziavpn/id1600529900',
  },
  macos: {
    v2box: 'https://apps.apple.com/app/v2box-v2ray-client/id6446814690',
    foxray: 'https://apps.apple.com/app/foxray/id6448898396',
    amnezia: 'https://amnezia.org/downloads',
  },
  android: {
    v2rayng: 'https://github.com/2dust/v2rayNG/releases/latest',
    nekobox:
      'https://github.com/MatsuriDayo/NekoBoxForAndroid/releases/latest',
    amnezia: 'https://amnezia.org/downloads',
  },
  windows: {
    nekoray: 'https://github.com/MatsuriDayo/nekoray/releases/latest',
    hiddify: 'https://github.com/hiddify/hiddify-next/releases/latest',
    amnezia: 'https://amnezia.org/downloads',
  },
  linux: {
    nekoray: 'https://github.com/MatsuriDayo/nekoray/releases/latest',
    amnezia: 'https://amnezia.org/downloads',
  },
} as const;

/** Регулярка для имени VPN-юзера (показываемое имя). 1-32 символа, без управляющих. */
export const VPN_USER_NAME_REGEX = /^[a-zA-Z0-9_\- .]{1,32}$/;

/** Регулярка для проверки CIDR подсети v4. */
export const IPV4_CIDR_REGEX =
  /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\/([1-9]|[12][0-9]|3[0-2])$/;
