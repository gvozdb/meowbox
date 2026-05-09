/**
 * Установщики runtime'ов VPN-протоколов.
 *
 * Юзер на странице /vpn нажимает «Установить Xray» / «Установить AmneziaWG» —
 * это запускает один из методов отсюда. Никаких автоматических system-миграций
 * не используется (см. жалобу заказчика — ставим только тот тип, который он
 * явно выбрал).
 *
 * Идемпотентность обязательна.
 *
 * Платформа — только Ubuntu (как и вся панель).
 */

import * as fsp from 'fs/promises';
import { CommandExecutor } from '../command-executor';
import { VPN_RUNTIME_USER, XRAY_BINARY_PATH, VPN_STATE_DIR } from '@meowbox/shared';

const XRAY_MIN_VERSION: [number, number, number] = [1, 8, 0];

export interface InstallStatus {
  /** Установлен ли binary/пакет. */
  installed: boolean;
  /** Версия (semver или произвольный лейбл). null если не установлен. */
  version: string | null;
  /** Произвольная инфа для UI. */
  details?: string;
}

export interface InstallResult {
  installed: boolean;
  version: string | null;
}

export class VpnInstaller {
  constructor(private readonly cmd: CommandExecutor) {}

  // ============= Xray =============

  async getXrayStatus(): Promise<InstallStatus> {
    try {
      const res = await this.cmd.execute(XRAY_BINARY_PATH, ['version'], { allowFailure: true });
      if (res.exitCode !== 0) {
        return { installed: false, version: null };
      }
      const ver = parseSemver(res.stdout);
      return {
        installed: !!ver && gte(ver, XRAY_MIN_VERSION),
        version: ver ? ver.join('.') : null,
        details: res.stdout.split('\n')[0].trim(),
      };
    } catch {
      return { installed: false, version: null };
    }
  }

  async installXray(): Promise<InstallResult> {
    // 1) Если уже стоит свежее — skip.
    const existing = await this.getXrayStatus();
    if (existing.installed) {
      // Юзер meowbox-vpn / state-папка тоже могли быть удалены — добиваем.
      await this.ensureRuntimeUser();
      await this.ensureStateDir();
      return { installed: true, version: existing.version };
    }

    // 2) Скачиваем бинарь.
    const arch = detectArch();
    const url = `https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${arch}.zip`;
    const tmpZip = '/tmp/meowbox-xray.zip';
    const tmpDir = '/tmp/meowbox-xray-extract';
    await this.cmd.execute('curl', ['-fsSL', '--retry', '3', '-o', tmpZip, url]);
    await this.cmd.execute('rm', ['-rf', tmpDir]);
    await this.cmd.execute('mkdir', ['-p', tmpDir]);
    await this.cmd.execute('unzip', ['-q', '-o', tmpZip, '-d', tmpDir]);
    await this.cmd.execute('cp', [`${tmpDir}/xray`, XRAY_BINARY_PATH]);
    await this.cmd.execute('chmod', ['0755', XRAY_BINARY_PATH]);
    await this.cmd.execute('rm', ['-rf', tmpZip, tmpDir]);

    // 3) Окружение.
    await this.ensureRuntimeUser();
    await this.ensureStateDir();

    // 4) Финальная проверка.
    const status = await this.getXrayStatus();
    if (!status.installed) {
      throw new Error(`Xray установлен, но version-проверка не прошла: ${status.details ?? ''}`);
    }
    return { installed: true, version: status.version };
  }

  /**
   * Полное удаление xray binary.
   *
   * Юзера meowbox-vpn И state-папку НЕ трогаем — их могут использовать
   * существующие сервисы (например AmneziaWG-сервисы могут продолжать жить).
   * Если все VPN-сервисы удалены — оператор сам решит, чистить ли state.
   *
   * Caller должен убедиться, что нет активных VLESS+Reality сервисов перед
   * вызовом — это валидация на уровне API.
   */
  async uninstallXray(): Promise<void> {
    try {
      await fsp.rm(XRAY_BINARY_PATH, { force: true });
    } catch {
      /* noop */
    }
  }

  // ============= AmneziaWG =============

  async getAmneziaStatus(): Promise<InstallStatus> {
    // 1) Самый надёжный способ — dpkg. PPA `ppa:amnezia/ppa` ставит
    //    `amneziawg-tools`, бинарь приходит вместе с пакетом.
    try {
      const dpkg = await this.cmd.execute('dpkg-query', [
        '-W',
        '-f=${Status}|${Version}\n',
        'amneziawg-tools',
      ], { allowFailure: true });
      if (dpkg.exitCode === 0) {
        const line = dpkg.stdout.split('\n')[0].trim();
        const [status, version] = line.split('|');
        if (status && status.includes('install ok installed')) {
          return {
            installed: true,
            version: version || 'unknown',
            details: 'amneziawg-tools (dpkg)',
          };
        }
      }
    } catch {
      /* dpkg отсутствует — не Debian/Ubuntu, fallback ниже */
    }

    // 2) Fallback: бинарь awg. CommandExecutor НЕ кидает исключение при
    //    ENOENT — возвращает exitCode=1. Раньше тут был вечный installed:true
    //    из-за этой разницы в контракте. Теперь проверяем exitCode явно
    //    и плюс — что вывод реально от AmneziaWG, а не симлинк/wrapper на wg.
    try {
      const res = await this.cmd.execute('awg', ['--version'], { allowFailure: true });
      if (res.exitCode !== 0) {
        return { installed: false, version: null };
      }
      const out = `${res.stdout}\n${res.stderr}`;
      const isAmnezia = /amnezia/i.test(out);
      if (!isAmnezia) {
        // Бинарь awg есть, но это не AmneziaWG (например симлинк на wg).
        return { installed: false, version: null, details: 'awg найден, но это не AmneziaWG' };
      }
      const m = out.match(/v?(\d+\.\d+(?:\.\d+)?)/);
      return {
        installed: true,
        version: m ? m[1] : 'unknown',
        details: out.split('\n')[0].trim(),
      };
    } catch {
      return { installed: false, version: null };
    }
  }

  async installAmnezia(): Promise<InstallResult> {
    const existing = await this.getAmneziaStatus();
    if (existing.installed) {
      await this.ensureSysctlForwarding();
      return { installed: true, version: existing.version };
    }

    // Только Ubuntu — оператор предупреждён в спеке.
    if (!(await this.exists('/usr/bin/apt-get'))) {
      throw new Error(
        'apt-get не найден. AmneziaWG поддерживается только на Debian/Ubuntu.',
      );
    }

    // 1) Убедиться что есть add-apt-repository.
    const whichRes = await this.cmd.execute('which', ['add-apt-repository'], { allowFailure: true });
    if (whichRes.exitCode !== 0) {
      await this.aptInstall(['software-properties-common']);
    }

    // 2) Подключить ppa. Может быть уже подключён — это не блокер.
    const ppaRes = await this.cmd.execute('add-apt-repository', [
      '-y',
      'ppa:amnezia/ppa',
    ], { allowFailure: true });
    if (ppaRes.exitCode !== 0) {
      console.warn(
        `[vpn-installer] add-apt-repository ppa:amnezia/ppa exit ${ppaRes.exitCode}: ${(ppaRes.stderr || ppaRes.stdout).slice(0, 200)}`,
      );
    }

    // 3) Установка пакетов.
    await this.aptInstall(['amneziawg', 'amneziawg-tools']);

    // 4) sysctl forwarding.
    await this.ensureSysctlForwarding();

    const status = await this.getAmneziaStatus();
    if (!status.installed) {
      throw new Error('Установка AmneziaWG не дала рабочего бинаря awg');
    }
    return { installed: true, version: status.version };
  }

  /**
   * Удалить AmneziaWG: apt-get remove + сносим sysctl-конфиг.
   * Не трогаем meowbox-vpn (он от Xray).
   */
  async uninstallAmnezia(): Promise<void> {
    if (!(await this.exists('/usr/bin/apt-get'))) return;
    try {
      await this.cmd.execute('apt-get', [
        '-y',
        '-qq',
        '-o',
        'Dpkg::Options::=--force-confdef',
        '-o',
        'Dpkg::Options::=--force-confold',
        'remove',
        'amneziawg',
        'amneziawg-tools',
      ]);
    } catch {
      /* пакет мог не быть установлен */
    }
    try {
      await fsp.rm('/etc/sysctl.d/99-meowbox-vpn.conf', { force: true });
    } catch {
      /* noop */
    }
  }

  // ============= helpers =============

  private async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Создаёт юзера meowbox-vpn (runtime user для Xray-systemd-юнитов). */
  private async ensureRuntimeUser(): Promise<void> {
    // `id` возвращает 1 если юзера нет — это нормальный сценарий проверки,
    // поэтому allowFailure: true. Без него execute бросит CommandError, и
    // мы попадём в "ловлю", вместо того чтобы спокойно создать юзера.
    const idRes = await this.cmd.execute('/usr/bin/id', [VPN_RUNTIME_USER], { allowFailure: true });
    if (idRes.exitCode === 0) return;

    // useradd должен пройти — если упал, это реальная ошибка → throw сам.
    await this.cmd.execute('/usr/sbin/useradd', [
      '--system',
      '--no-create-home',
      '--shell',
      '/usr/sbin/nologin',
      VPN_RUNTIME_USER,
    ]);
  }

  /** Создаёт `/opt/meowbox/state/vpn`. */
  private async ensureStateDir(): Promise<void> {
    await fsp.mkdir(VPN_STATE_DIR, { recursive: true, mode: 0o755 });
  }

  /** Включает ip_forward (нужно для AmneziaWG). */
  private async ensureSysctlForwarding(): Promise<void> {
    const sysctlFile = '/etc/sysctl.d/99-meowbox-vpn.conf';
    const desired = 'net.ipv4.ip_forward=1\nnet.ipv6.conf.all.forwarding=1\n';
    let needWrite = true;
    if (await this.exists(sysctlFile)) {
      try {
        const cur = await fsp.readFile(sysctlFile, 'utf-8');
        if (cur.trim() === desired.trim()) needWrite = false;
      } catch {
        /* перезапишем */
      }
    }
    if (needWrite) {
      await fsp.writeFile(sysctlFile, desired, { mode: 0o644 });
    }
    try {
      await this.cmd.execute('/usr/sbin/sysctl', ['-p', sysctlFile]);
    } catch {
      // Не критично — оператор может перезагрузить сервер.
    }
  }

  private async aptInstall(packages: string[]): Promise<void> {
    // apt update.
    await this.cmd.execute(
      'apt-get',
      ['-y', '-qq', 'update'],
      { env: { DEBIAN_FRONTEND: 'noninteractive', PATH: process.env.PATH || '' } },
    );
    await this.cmd.execute(
      'apt-get',
      [
        '-y',
        '-qq',
        '-o',
        'Dpkg::Options::=--force-confdef',
        '-o',
        'Dpkg::Options::=--force-confold',
        'install',
        ...packages,
      ],
      { env: { DEBIAN_FRONTEND: 'noninteractive', PATH: process.env.PATH || '' } },
    );
  }
}

function parseSemver(s: string): [number, number, number] | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function gte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

function detectArch(): string {
  const a = process.arch;
  if (a === 'x64') return '64';
  if (a === 'arm64') return 'arm64-v8a';
  if (a === 'arm') return 'arm32-v7a';
  throw new Error(`Unsupported arch for Xray: ${a}`);
}
