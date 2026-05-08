/**
 * Контракт VPN-провайдера на стороне API.
 *
 * Каждый протокол (VLESS+Reality, AmneziaWG, ...) имеет свой провайдер,
 * который:
 *   - валидирует параметры install/addUser;
 *   - оркестрирует RPC к агенту через AgentRelayService;
 *   - умеет рендерить клиентский конфиг (vless URL / wg-quick text);
 *
 * См. docs/specs/2026-05-09-vpn-management.md §4.
 */

import {
  VpnProtocol,
  VpnInstallOptions,
  VpnUserCredsView,
  VpnServiceConfig,
  VpnUserCreds,
} from '@meowbox/shared';

export interface VpnProvider {
  readonly protocol: VpnProtocol;

  /** Развернуть сервис на сервере. Возвращает расшифрованный config (для шифрования и записи в БД). */
  install(opts: VpnInstallOptions, serviceId: string): Promise<VpnServiceConfig>;

  /** Полное удаление. Не должен бросаться, если сервис уже не существует. */
  uninstall(serviceId: string, port: number): Promise<void>;

  /** Текущий статус (active/inactive) с агента. */
  isActive(serviceId: string): Promise<boolean>;

  start(serviceId: string): Promise<void>;
  stop(serviceId: string): Promise<void>;

  /**
   * Сгенерить креды нового юзера в этом сервисе.
   * Возвращает зашифровываемые creds — НЕ применяя их на агенте.
   * Применение делается через addUser ниже после записи в БД.
   */
  generateUserCreds(serviceConfig: VpnServiceConfig, allocatedIp?: string): Promise<VpnUserCreds>;

  /** Применить юзера на агенте (мутация config.json / awg set). */
  applyAddUser(
    serviceId: string,
    serviceConfig: VpnServiceConfig,
    creds: VpnUserCreds,
    name: string,
  ): Promise<void>;

  /** Снять юзера с агента (без удаления БД). */
  applyRemoveUser(
    serviceId: string,
    serviceConfig: VpnServiceConfig,
    creds: VpnUserCreds,
  ): Promise<void>;

  /**
   * Сборка клиентского конфига (vless:// URL или wg-quick conf) +
   * генерация QR PNG. Эта функция чистая — никаких мутаций на агенте.
   */
  renderUserView(
    serviceConfig: VpnServiceConfig,
    creds: VpnUserCreds,
    publicHost: string,
    port: number,
    userName: string,
  ): Promise<VpnUserCredsView>;
}

/** Утилита для всех провайдеров: PNG-QR из строки. */
export async function renderQrPng(text: string): Promise<string> {
  // Импорт лениво — qrcode тяжелый.
  const qrcode = await import('qrcode');
  const png = await qrcode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 384,
  });
  return png.toString('base64');
}
