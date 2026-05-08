/**
 * VPN: AmneziaWG (обфусцированный WireGuard).
 *
 * См. docs/specs/2026-05-09-vpn-management.md §8.
 *
 * Жизненный цикл:
 *   - install: gen keypair, gen obfuscation params, write /etc/amneziawg/awg-<id8>.conf,
 *     systemctl enable --now awg-quick@<iface>, ufw allow port/udp.
 *   - addUser: gen peer keys+psk, выдать IP, awg set + dopisat в conf.
 *   - removeUser: awg set ... peer ... remove + удалить из conf.
 *   - uninstall: systemctl disable --now awg-quick@<iface>, rm conf, ufw delete.
 *
 * IP-аллокация: per-service внутри `<network>` через IP-аддиции по битам.
 * Сервер всегда занимает .1, юзеры начинают с .2 и идут вверх.
 */

import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import { CommandExecutor } from '../command-executor';
import type {
  AmneziaInstallParams,
  AmneziaInstallResult,
  AmneziaUserAddParams,
  AmneziaUserRemoveParams,
  VpnAmneziaWgServiceConfig,
} from './types';
import { VpnProtocol } from '@meowbox/shared';

const SERVICE_LOCKS = new Map<string, Promise<unknown>>();

function withLock<T>(serviceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = SERVICE_LOCKS.get(serviceId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  SERVICE_LOCKS.set(
    serviceId,
    next.catch(() => undefined),
  );
  return next;
}

/** Генерирует короткий префикс интерфейса 8 символов из serviceId — IFNAMSIZ=15 ограничение. */
function ifaceName(serviceId: string): string {
  // serviceId это uuid, берём первые 8 символов hex без дефиса
  const short = serviceId.replace(/-/g, '').slice(0, 8);
  return `awg-${short}`;
}

function confPath(serviceId: string): string {
  return `/etc/amneziawg/${ifaceName(serviceId)}.conf`;
}

function unitName(serviceId: string): string {
  return `awg-quick@${ifaceName(serviceId)}`;
}

/** Прибавляет offset к IPv4 строке. Бросает если выходим за подсеть. */
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
  // Граница подсети
  const broadcast = masked + (~(~0 << (32 - prefix)) >>> 0);
  if (newInt >= broadcast) {
    throw new Error(`IP allocation overflow: offset=${offset} в подсети ${baseCidr}`);
  }
  return [
    (newInt >> 24) & 0xff,
    (newInt >> 16) & 0xff,
    (newInt >> 8) & 0xff,
    newInt & 0xff,
  ].join('.');
}

export class AmneziaWgManager {
  constructor(private readonly cmd: CommandExecutor) {}

  /** Генерирует WG-keypair (через `awg genkey | awg pubkey`). */
  async generateKeypair(): Promise<{ priv: string; pub: string }> {
    // 1) priv
    const { stdout: priv } = await this.cmd.execute('awg', ['genkey']);
    // 2) pub: нужно перенаправить priv в stdin awg pubkey. CommandExecutor.execute
    //    через execFile принимает stdin? Реализован ли input? Скорее нет —
    //    обходим через bash -c с echo. Но bash не allowlist'ed.
    //    Лучший путь — записать priv во временный файл и cat | awg pubkey.
    //    Проще: используем встроенный crypto API node (curve25519) — но
    //    awg тоже нужен для psk. Запишем priv через writeFile и pipe через
    //    spawnSync stdin.
    const pub = await this.derivePubKey(priv.trim());
    return { priv: priv.trim(), pub: pub.trim() };
  }

  async generatePsk(): Promise<string> {
    const { stdout } = await this.cmd.execute('awg', ['genpsk']);
    return stdout.trim();
  }

  /** awg pubkey принимает priv через stdin. CommandExecutor этого не умеет — fallback через child_process. */
  private async derivePubKey(priv: string): Promise<string> {
    const { spawn } = await import('child_process');
    return new Promise((resolve, reject) => {
      const proc = spawn('awg', ['pubkey'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout.on('data', (b) => (out += b.toString()));
      proc.stderr.on('data', (b) => (err += b.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`awg pubkey exit ${code}: ${err}`));
        else resolve(out.trim());
      });
      proc.stdin.write(priv + '\n');
      proc.stdin.end();
    });
  }

  /** Определяет egress-интерфейс по `ip route show default`. */
  async detectEgressIface(): Promise<string> {
    const { stdout } = await this.cmd.execute('ip', ['route', 'show', 'default']);
    const m = stdout.match(/dev\s+(\S+)/);
    if (!m) throw new Error('Не удалось определить egress-интерфейс (нет default route)');
    return m[1];
  }

  async install(params: AmneziaInstallParams): Promise<AmneziaInstallResult> {
    return withLock(params.serviceId, async () => {
      const iface = ifaceName(params.serviceId);

      // 1) Сгенерим серверный keypair и параметры обфускации.
      const { priv: srvPriv, pub: srvPub } = await this.generateKeypair();
      const serverIp = ipPlus(params.network, 1);
      const egressIface = await this.detectEgressIface();

      // Параметры обфускации — random в безопасном диапазоне.
      // Default WireGuard magic headers = 1,2,3,4 — их трогать нельзя
      // (детектируется DPI). Берём 32-битные числа, отличающиеся между собой
      // и от 1..4.
      const reservedHeaders = new Set([1, 2, 3, 4]);
      const headers: number[] = [];
      while (headers.length < 4) {
        const h = crypto.randomInt(5, 0x7fffffff); // [5, 2^31)
        if (!reservedHeaders.has(h) && !headers.includes(h)) headers.push(h);
      }
      const cfg: VpnAmneziaWgServiceConfig = {
        protocol: VpnProtocol.AMNEZIA_WG,
        srvPriv,
        srvPub,
        network: params.network,
        serverIp,
        dns: params.dns,
        mtu: params.mtu,
        egressIface,
        jc: crypto.randomInt(3, 11),
        jmin: 50,
        jmax: 1000,
        s1: crypto.randomInt(15, 200),
        s2: crypto.randomInt(15, 200),
        h1: headers[0],
        h2: headers[1],
        h3: headers[2],
        h4: headers[3],
      };

      // 2) Создать /etc/amneziawg, записать conf.
      await this.cmd.execute('mkdir', ['-p', '/etc/amneziawg']);
      await this.cmd.execute('chmod', ['0700', '/etc/amneziawg']);

      const confText = this.renderInterfaceConf(cfg, params.port);
      await this.writeAtomic(confPath(params.serviceId), confText, 0o600);

      // 3) systemctl enable --now awg-quick@<iface>
      await this.cmd.execute('systemctl', ['daemon-reload']);
      try {
        await this.cmd.execute('systemctl', ['enable', '--now', unitName(params.serviceId)]);
      } catch (err) {
        // Уберём conf чтобы не оставлять полу-инсталляцию.
        try {
          await fsp.rm(confPath(params.serviceId), { force: true });
        } catch {
          /* noop */
        }
        throw new Error(
          `awg-quick@${iface} не стартовал: ${(err as Error).message}. ` +
            `Проверь что kernel module amneziawg загружен (modprobe amneziawg).`,
        );
      }

      // 4) UFW.
      await this.openFirewall(params.port);

      return { config: cfg };
    });
  }

  async uninstall(serviceId: string, port: number): Promise<void> {
    return withLock(serviceId, async () => {
      try {
        await this.cmd.execute('systemctl', ['disable', '--now', unitName(serviceId)]);
      } catch {
        /* noop */
      }
      try {
        await fsp.rm(confPath(serviceId), { force: true });
      } catch {
        /* noop */
      }
      await this.closeFirewall(port);
    });
  }

  async stop(serviceId: string): Promise<void> {
    await this.cmd.execute('systemctl', ['stop', unitName(serviceId)]);
  }

  async start(serviceId: string): Promise<void> {
    await this.cmd.execute('systemctl', ['start', unitName(serviceId)]);
  }

  async statusActive(serviceId: string): Promise<boolean> {
    try {
      const { stdout } = await this.cmd.execute('systemctl', [
        'is-active',
        unitName(serviceId),
      ]);
      return stdout.trim() === 'active';
    } catch {
      return false;
    }
  }

  /**
   * Добавление peer'а: динамическое (без restart) через `awg set`,
   * + дописываем в conf чтобы пережить reboot.
   */
  async addUser(params: AmneziaUserAddParams): Promise<void> {
    return withLock(params.serviceId, async () => {
      const iface = ifaceName(params.serviceId);
      // 1) Записать PSK во временный файл (awg set требует pre-shared-key из файла).
      const pskFile = `/tmp/.meowbox-vpn-psk-${crypto.randomBytes(8).toString('hex')}`;
      try {
        await fsp.writeFile(pskFile, params.peerPsk + '\n', { mode: 0o600 });
        await this.cmd.execute('awg', [
          'set',
          iface,
          'peer',
          params.peerPub,
          'preshared-key',
          pskFile,
          'allowed-ips',
          `${params.peerIp}/32`,
        ]);
      } finally {
        try {
          await fsp.rm(pskFile, { force: true });
        } catch {
          /* noop */
        }
      }

      // 2) Дописать peer в conf файл (для persistance).
      const cur = await fsp.readFile(confPath(params.serviceId), 'utf-8');
      // Если уже есть PublicKey = X — пропускаем (идемпотентно).
      if (cur.includes(params.peerPub)) return;
      const peerBlock = `\n# Peer: ${this.escapeComment(params.name)}\n[Peer]\nPublicKey = ${params.peerPub}\nPresharedKey = ${params.peerPsk}\nAllowedIPs = ${params.peerIp}/32\n`;
      await this.writeAtomic(confPath(params.serviceId), cur + peerBlock, 0o600);
    });
  }

  async removeUser(params: AmneziaUserRemoveParams): Promise<void> {
    return withLock(params.serviceId, async () => {
      const iface = ifaceName(params.serviceId);
      try {
        await this.cmd.execute('awg', [
          'set',
          iface,
          'peer',
          params.peerPub,
          'remove',
        ]);
      } catch {
        /* peer мог уже быть удалён */
      }
      // Удалить блок из conf.
      const cur = await fsp.readFile(confPath(params.serviceId), 'utf-8');
      const purged = this.removePeerBlock(cur, params.peerPub);
      if (purged !== cur) {
        await this.writeAtomic(confPath(params.serviceId), purged, 0o600);
      }
    });
  }

  async rotateKeys(serviceId: string): Promise<{ srvPriv: string; srvPub: string }> {
    return withLock(serviceId, async () => {
      const { priv, pub } = await this.generateKeypair();
      const cur = await fsp.readFile(confPath(serviceId), 'utf-8');
      const updated = cur.replace(
        /^PrivateKey\s*=.*$/m,
        `PrivateKey = ${priv}`,
      );
      await this.writeAtomic(confPath(serviceId), updated, 0o600);
      // Перезапустить интерфейс.
      await this.cmd.execute('systemctl', ['restart', unitName(serviceId)]);
      return { srvPriv: priv, srvPub: pub };
    });
  }

  // --- helpers ---

  private renderInterfaceConf(
    cfg: VpnAmneziaWgServiceConfig,
    port: number,
  ): string {
    const network = cfg.network;
    const prefix = network.split('/')[1];
    return `# Generated by Meowbox VPN — не редактировать вручную, peer'ы добавляются динамически
[Interface]
PrivateKey = ${cfg.srvPriv}
ListenPort = ${port}
Address = ${cfg.serverIp}/${prefix}
MTU = ${cfg.mtu}
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -t nat -A POSTROUTING -o ${cfg.egressIface} -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -t nat -D POSTROUTING -o ${cfg.egressIface} -j MASQUERADE
Jc = ${cfg.jc}
Jmin = ${cfg.jmin}
Jmax = ${cfg.jmax}
S1 = ${cfg.s1}
S2 = ${cfg.s2}
H1 = ${cfg.h1}
H2 = ${cfg.h2}
H3 = ${cfg.h3}
H4 = ${cfg.h4}
`;
  }

  private escapeComment(name: string): string {
    return name.replace(/[\r\n]+/g, ' ').slice(0, 64);
  }

  /** Удаляет блок `# Peer: ...\n[Peer]\nPublicKey = X\n...` до следующей пустой строки или EOF. */
  private removePeerBlock(text: string, pubKey: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    let skip = false;
    let blockStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('[Peer]')) {
        // Запомним этот блок и решим позже.
        blockStart = result.length;
        result.push(line);
        skip = false;
        continue;
      }
      if (blockStart >= 0 && line.trim() === '' && !skip) {
        // Конец блока.
        blockStart = -1;
        result.push(line);
        continue;
      }
      if (blockStart >= 0 && line.includes(pubKey)) {
        // Этот блок надо удалить — откатим всё с blockStart.
        // Также сожрём предыдущую строку-комментарий "# Peer: ..."
        let popTo = blockStart;
        if (popTo > 0 && result[popTo - 1].startsWith('# Peer:')) popTo--;
        result.length = popTo;
        skip = true;
        blockStart = -1;
        // Пропустить остаток блока до пустой строки.
        for (i = i + 1; i < lines.length; i++) {
          if (lines[i].trim() === '') break;
        }
        continue;
      }
      result.push(line);
    }
    return result.join('\n');
  }

  private async writeAtomic(filePath: string, content: string, mode: number): Promise<void> {
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, content, { mode });
    await fsp.rename(tmp, filePath);
  }

  private async openFirewall(port: number): Promise<void> {
    try {
      await this.cmd.execute('which', ['ufw']);
    } catch {
      return;
    }
    try {
      await this.cmd.execute('ufw', ['allow', `${port}/udp`]);
    } catch (err) {
      console.warn(`[awg] ufw allow ${port}/udp: ${(err as Error).message}`);
    }
  }

  private async closeFirewall(port: number): Promise<void> {
    try {
      await this.cmd.execute('which', ['ufw']);
    } catch {
      return;
    }
    try {
      await this.cmd.execute('ufw', ['delete', 'allow', `${port}/udp`]);
    } catch {
      /* noop */
    }
  }
}

// Экспорт хелпера наружу — пригодится в API для подсчёта свободного IP.
export { ipPlus };
