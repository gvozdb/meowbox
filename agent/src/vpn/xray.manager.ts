/**
 * VPN: VLESS+Reality через Xray-core.
 *
 * См. docs/specs/2026-05-09-vpn-management.md §7.
 *
 * Жизненный цикл сервиса:
 *   1) install — генерим x25519 keypair, валидируем SNI, пишем config.json
 *      и systemd unit, открываем порт ufw, систему стартуем.
 *   2) addUser — мутируем config.json (clients[]) + reload xray (SIGHUP).
 *   3) removeUser — обратное.
 *   4) uninstall — systemctl stop+disable, ufw delete, rm -rf state-папка.
 *
 * Все JSON-операции с конфигом xray идут через mutex-обёртку
 * (per-service Promise chain), чтобы не было гонок при параллельных
 * addUser/removeUser.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as net from 'net';
import * as tls from 'tls';
import { CommandExecutor } from '../command-executor';
import type {
  XrayInstallParams,
  XrayInstallResult,
  XrayUserAddParams,
  XrayUserRemoveParams,
  VpnRealityServiceConfig,
} from './types';
import {
  VPN_STATE_DIR,
  VPN_RUNTIME_USER,
  XRAY_BINARY_PATH,
  XRAY_SYSTEMD_PREFIX,
  DEFAULT_REALITY_FINGERPRINT,
  VpnProtocol,
} from '@meowbox/shared';
import type { SniValidationResult } from '@meowbox/shared';

const SERVICE_LOCKS = new Map<string, Promise<unknown>>();

/** Сериализует операции на одном service по id, чтобы избежать race на config.json. */
function withLock<T>(serviceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = SERVICE_LOCKS.get(serviceId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  SERVICE_LOCKS.set(
    serviceId,
    next.catch(() => undefined),
  );
  return next;
}

interface XrayClientEntry {
  id: string;
  flow: string;
  email?: string;
}

interface XrayConfigJson {
  log: { loglevel: string };
  inbounds: Array<{
    tag: string;
    listen: string;
    port: number;
    protocol: string;
    settings: { clients: XrayClientEntry[]; decryption: string };
    streamSettings: {
      network: string;
      security: string;
      realitySettings: {
        show: boolean;
        dest: string;
        xver: number;
        serverNames: string[];
        privateKey: string;
        shortIds: string[];
      };
    };
    sniffing: { enabled: boolean; destOverride: string[] };
  }>;
  outbounds: Array<{ protocol: string; tag: string }>;
}

export class XrayManager {
  constructor(private readonly cmd: CommandExecutor) {}

  /** Полный путь до конфиг-файла сервиса. */
  private configPath(serviceId: string): string {
    return path.join(VPN_STATE_DIR, serviceId, 'config.json');
  }

  /** Полный путь до systemd unit'а. */
  private systemdUnit(serviceId: string): string {
    return `${XRAY_SYSTEMD_PREFIX}${serviceId}.service`;
  }

  /** Генерирует x25519 keypair через `xray x25519`. */
  async generateKeypair(): Promise<{ privKey: string; pubKey: string }> {
    if (!fs.existsSync(XRAY_BINARY_PATH)) {
      throw new Error(
        `Xray не установлен (${XRAY_BINARY_PATH} не найден). ` +
          `Запусти системную миграцию 2026-05-09-002-install-xray.`,
      );
    }
    const { stdout } = await this.cmd.execute(XRAY_BINARY_PATH, ['x25519']);
    const privMatch = stdout.match(/Private key:\s*([\w-]+)/i);
    const pubMatch = stdout.match(/Public key:\s*([\w-]+)/i);
    if (!privMatch || !pubMatch) {
      throw new Error(`Не смог распарсить вывод xray x25519: ${stdout.slice(0, 200)}`);
    }
    return { privKey: privMatch[1], pubKey: pubMatch[1] };
  }

  /**
   * Проверяет, что SNI-маска отдаёт TLS 1.3 + X25519 с этого сервера.
   * Чисто-Node реализация (без openssl s_client) — надёжнее на разных системах.
   */
  async validateSni(sniMask: string): Promise<SniValidationResult> {
    return new Promise((resolve) => {
      const socket = net.connect(443, sniMask);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, reason: 'connect timeout (10s)' });
      }, 10_000);

      socket.once('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: `connect: ${err.message}` });
      });

      socket.once('connect', () => {
        const tlsSocket = tls.connect({
          socket,
          servername: sniMask,
          // Node.js >= 18 умеет min/maxVersion. Принудительно требуем 1.3.
          minVersion: 'TLSv1.3',
          maxVersion: 'TLSv1.3',
          // Кривая X25519 в supported_groups запрашивается по дефолту в Node ≥ 12.
          // Дополнительно явно укажем — на случай если в будущем дефолт поменяется.
          // ecdhCurve: 'X25519:P-256:P-384', // не поддерживается всеми версиями
        });
        tlsSocket.once('error', (err) => {
          clearTimeout(timer);
          resolve({ ok: false, reason: `tls: ${err.message}` });
          tlsSocket.destroy();
        });
        tlsSocket.once('secureConnect', () => {
          clearTimeout(timer);
          const proto = tlsSocket.getProtocol();
          // EphemeralKeyInfo даёт сведения о DHE/ECDHE — нам важна группа.
          // Тип в @types/node: object | EphemeralKeyInfo, поэтому каст.
          const eki = (tlsSocket as unknown as { getEphemeralKeyInfo?: () => { name?: string } | object | null })
            .getEphemeralKeyInfo?.();
          const group = (eki && typeof eki === 'object' && 'name' in eki ? (eki as { name?: string }).name : undefined);
          tlsSocket.destroy();

          if (proto !== 'TLSv1.3') {
            resolve({
              ok: false,
              tlsVersion: proto ?? undefined,
              group,
              reason: `expected TLSv1.3, got ${proto ?? 'unknown'}`,
            });
            return;
          }
          if (group && group !== 'X25519') {
            resolve({
              ok: false,
              tlsVersion: proto,
              group,
              reason: `expected X25519, got ${group}`,
            });
            return;
          }
          resolve({ ok: true, tlsVersion: proto, group });
        });
      });
    });
  }

  /** install: создать сервис на машине. Идемпотентно по serviceId (если уже есть — сбросит конфиг). */
  async install(params: XrayInstallParams): Promise<XrayInstallResult> {
    return withLock(params.serviceId, async () => {
      // 1) Validate SNI.
      const sniResult = await this.validateSni(params.sniMask);
      if (!sniResult.ok) {
        throw new Error(`SNI-маска ${params.sniMask} не подходит: ${sniResult.reason}`);
      }

      // 2) Сгенерим ключи и shortId.
      const { privKey, pubKey } = await this.generateKeypair();
      const shortId = crypto.randomBytes(8).toString('hex');

      const cfg: VpnRealityServiceConfig = {
        protocol: VpnProtocol.VLESS_REALITY,
        privKey,
        pubKey,
        shortId,
        sniMask: params.sniMask,
        fingerprint: DEFAULT_REALITY_FINGERPRINT,
      };

      // 3) Создаём папку, пишем config.json.
      const dir = path.join(VPN_STATE_DIR, params.serviceId);
      await fsp.mkdir(dir, { recursive: true, mode: 0o750 });
      // chown на meowbox-vpn — чтобы systemd-юнит мог читать.
      await this.cmd.execute('chown', ['-R', `${VPN_RUNTIME_USER}:${VPN_RUNTIME_USER}`, dir]);

      const configJson = this.buildEmptyConfig(cfg, params.port);
      await this.writeConfig(params.serviceId, configJson);

      // 4) Systemd unit.
      await this.writeSystemdUnit(params.serviceId);
      await this.cmd.execute('systemctl', ['daemon-reload']);
      await this.cmd.execute('systemctl', ['enable', '--now', this.systemdUnit(params.serviceId)]);

      // 5) UFW (открыть порт). Если ufw не установлен — тихо пропускаем,
      // оператор сам разберётся с iptables/cloud-firewall.
      await this.openFirewall(params.port, 'tcp');

      return { config: cfg };
    });
  }

  /** Полное удаление сервиса. */
  async uninstall(serviceId: string, port: number): Promise<void> {
    return withLock(serviceId, async () => {
      const unit = this.systemdUnit(serviceId);
      try {
        await this.cmd.execute('systemctl', ['disable', '--now', unit]);
      } catch {
        /* unit может не существовать — ок */
      }
      const unitFile = `/etc/systemd/system/${unit}`;
      try {
        await fsp.rm(unitFile, { force: true });
      } catch {
        /* noop */
      }
      try {
        await this.cmd.execute('systemctl', ['daemon-reload']);
      } catch {
        /* noop */
      }
      const dir = path.join(VPN_STATE_DIR, serviceId);
      await this.cmd.execute('rm', ['-rf', dir]);
      await this.closeFirewall(port, 'tcp');
    });
  }

  async stop(serviceId: string): Promise<void> {
    await this.cmd.execute('systemctl', ['stop', this.systemdUnit(serviceId)]);
  }

  async start(serviceId: string): Promise<void> {
    await this.cmd.execute('systemctl', ['start', this.systemdUnit(serviceId)]);
  }

  async statusActive(serviceId: string): Promise<boolean> {
    try {
      const { stdout } = await this.cmd.execute('systemctl', [
        'is-active',
        this.systemdUnit(serviceId),
      ]);
      return stdout.trim() === 'active';
    } catch {
      return false;
    }
  }

  async addUser(params: XrayUserAddParams): Promise<void> {
    return withLock(params.serviceId, async () => {
      const cfg = await this.readConfig(params.serviceId);
      const inbound = cfg.inbounds[0];
      // Если такой UUID уже есть — пропускаем (идемпотентно).
      if (inbound.settings.clients.find((c) => c.id === params.uuid)) return;
      inbound.settings.clients.push({
        id: params.uuid,
        flow: 'xtls-rprx-vision',
        email: params.name,
      });
      await this.writeConfig(params.serviceId, cfg);
      await this.reload(params.serviceId);
    });
  }

  async removeUser(params: XrayUserRemoveParams): Promise<void> {
    return withLock(params.serviceId, async () => {
      const cfg = await this.readConfig(params.serviceId);
      const inbound = cfg.inbounds[0];
      const before = inbound.settings.clients.length;
      inbound.settings.clients = inbound.settings.clients.filter((c) => c.id !== params.uuid);
      if (inbound.settings.clients.length === before) return; // не было такого
      await this.writeConfig(params.serviceId, cfg);
      await this.reload(params.serviceId);
    });
  }

  /**
   * Сменить SNI-маску. Не сбрасывает ключи (privKey/pubKey остаются).
   * Все юзеры останутся валидными после reload, но клиенты должны перетянуть
   * subscription чтобы получить новый sni= в URL.
   */
  async rotateSni(serviceId: string, newSni: string): Promise<void> {
    return withLock(serviceId, async () => {
      const sniResult = await this.validateSni(newSni);
      if (!sniResult.ok) {
        throw new Error(`SNI ${newSni} не подходит: ${sniResult.reason}`);
      }
      const cfg = await this.readConfig(serviceId);
      const inbound = cfg.inbounds[0];
      inbound.streamSettings.realitySettings.dest = `${newSni}:443`;
      inbound.streamSettings.realitySettings.serverNames = [newSni];
      await this.writeConfig(serviceId, cfg);
      await this.reload(serviceId);
    });
  }

  /** Полная ротация серверного keypair. После — все клиенты должны перетянуть subscription. */
  async rotateKeys(
    serviceId: string,
  ): Promise<{ privKey: string; pubKey: string; shortId: string }> {
    return withLock(serviceId, async () => {
      const { privKey, pubKey } = await this.generateKeypair();
      const shortId = crypto.randomBytes(8).toString('hex');
      const cfg = await this.readConfig(serviceId);
      const inbound = cfg.inbounds[0];
      inbound.streamSettings.realitySettings.privateKey = privKey;
      inbound.streamSettings.realitySettings.shortIds = [shortId];
      await this.writeConfig(serviceId, cfg);
      await this.reload(serviceId);
      return { privKey, pubKey, shortId };
    });
  }

  // --- internals ---

  private buildEmptyConfig(
    cfg: VpnRealityServiceConfig,
    port: number,
  ): XrayConfigJson {
    return {
      log: { loglevel: 'warning' },
      inbounds: [
        {
          tag: 'vless-reality-in',
          listen: '0.0.0.0',
          port,
          protocol: 'vless',
          settings: { clients: [], decryption: 'none' },
          streamSettings: {
            network: 'tcp',
            security: 'reality',
            realitySettings: {
              show: false,
              dest: `${cfg.sniMask}:443`,
              xver: 0,
              serverNames: [cfg.sniMask],
              privateKey: cfg.privKey,
              shortIds: [cfg.shortId],
            },
          },
          sniffing: {
            enabled: true,
            destOverride: ['http', 'tls', 'quic'],
          },
        },
      ],
      outbounds: [{ protocol: 'freedom', tag: 'direct' }],
    };
  }

  private async readConfig(serviceId: string): Promise<XrayConfigJson> {
    const raw = await fsp.readFile(this.configPath(serviceId), 'utf-8');
    return JSON.parse(raw) as XrayConfigJson;
  }

  private async writeConfig(serviceId: string, cfg: XrayConfigJson): Promise<void> {
    const file = this.configPath(serviceId);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o640 });
    await fsp.rename(tmp, file);
    // Owner — meowbox-vpn чтобы systemd мог читать после атомарной записи.
    try {
      await this.cmd.execute('chown', [`${VPN_RUNTIME_USER}:${VPN_RUNTIME_USER}`, file]);
    } catch {
      /* noop */
    }
  }

  private async writeSystemdUnit(serviceId: string): Promise<void> {
    const unit = `[Unit]
Description=Meowbox VPN (Xray Reality) — ${serviceId}
After=network.target nss-lookup.target

[Service]
User=${VPN_RUNTIME_USER}
ExecStart=${XRAY_BINARY_PATH} run -c ${this.configPath(serviceId)}
Restart=on-failure
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${path.join(VPN_STATE_DIR, serviceId)}
PrivateTmp=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;
    const file = `/etc/systemd/system/${this.systemdUnit(serviceId)}`;
    await fsp.writeFile(file, unit, { mode: 0o644 });
  }

  /**
   * Reload xray. Xray умеет hot-reload через kill -HUP, но
   * systemd ExecReload не настроен в нашем юните — используем restart.
   * Это даст ~1с дисконнект клиентам, что приемлемо.
   */
  private async reload(serviceId: string): Promise<void> {
    await this.cmd.execute('systemctl', ['restart', this.systemdUnit(serviceId)]);
  }

  private async openFirewall(port: number, proto: 'tcp' | 'udp'): Promise<void> {
    try {
      await this.cmd.execute('which', ['ufw']);
    } catch {
      return; // ufw нет — пропускаем
    }
    try {
      // ufw allow 443/tcp
      await this.cmd.execute('ufw', ['allow', `${port}/${proto}`]);
    } catch (err) {
      // не критично, оператор разберётся
      console.warn(`[xray] ufw allow ${port}/${proto} failed: ${(err as Error).message}`);
    }
  }

  private async closeFirewall(port: number, proto: 'tcp' | 'udp'): Promise<void> {
    try {
      await this.cmd.execute('which', ['ufw']);
    } catch {
      return;
    }
    try {
      await this.cmd.execute('ufw', ['delete', 'allow', `${port}/${proto}`]);
    } catch {
      /* noop */
    }
  }
}
