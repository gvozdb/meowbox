import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { CommandExecutor } from '../command-executor';

/**
 * Postfix executor — системная почта (relay через внешний SMTP).
 *
 * Архитектура:
 *   - Ставим postfix как **null-client**: locally сгенерированная почта
 *     отправляется через smarthost (Gmail / Yandex / Mailgun / custom);
 *     ВХОДЯЩУЮ почту postfix не принимает (inet_interfaces=loopback-only),
 *     локальная доставка отключена (local_transport=error).
 *   - Credentials хранятся в `/etc/postfix/sasl_passwd` (root:root 0600),
 *     индексируются `postmap` → `.db` файл. Без 0600 postfix откажется
 *     грузить (sasl_passwd_secure: yes).
 *   - `/etc/postfix/generic` — canonical-маппинг локального отправителя
 *     (`root@hostname`) на `fromEmail` — иначе Gmail/Yandex отобьют письмо
 *     по SPF, т.к. `hostname` обычно никому не принадлежит.
 *   - `/etc/aliases` — добавляем `root: adminEmail`, `newaliases` пересобирает.
 *
 * Безопасность:
 *   - Пароль ВСЕГДА удаляется из ответов API — наружу отдаём только
 *     наличие пароля (`hasPassword`).
 *   - Все user-controlled поля санитайзятся (host/port/email/username).
 *   - Атомарная запись через rename + бэкапы перед изменением.
 *   - При падении restart'а откатываем main.cf и sasl_passwd из бэкапа.
 *
 * NB: не путать с MTA для пользовательских ящиков — мы НЕ принимаем входящую
 *     почту и не делаем виртуальные домены. Это relay-only для системных алертов.
 */

const MAIN_CF = '/etc/postfix/main.cf';
const SASL_PASSWD = '/etc/postfix/sasl_passwd';
const GENERIC_MAP = '/etc/postfix/generic';
const ALIASES = '/etc/aliases';
const MEOWBOX_MARK = '# meowbox-managed: do not edit — overwritten on /services apply';

export interface ServerStatus {
  installed: boolean;
  version: string | null;
}

export interface RelayPreset {
  key: string;
  name: string;
  description: string;
  host: string;
  port: number;
  /** true → SMTPS (порт 465, wrappermode TLS). false → STARTTLS (587). */
  wrapperSSL: boolean;
  /** Подсказка для UI (например, «Gmail требует app password, обычный пароль не пройдёт»). */
  hint?: string;
  /** Дефолтное значение поля username (например `apikey` для SendGrid). */
  defaultUsername?: string;
}

export const POSTFIX_RELAY_PRESETS: readonly RelayPreset[] = [
  {
    key: 'gmail',
    name: 'Gmail (smtp.gmail.com:587)',
    description: 'Gmail / Google Workspace через STARTTLS на 587.',
    host: 'smtp.gmail.com',
    port: 587,
    wrapperSSL: false,
    hint: 'Включи 2FA → создай app password (https://myaccount.google.com/apppasswords) — обычный пароль Google не пропустит.',
  },
  {
    key: 'yandex',
    name: 'Yandex.Mail (smtp.yandex.ru:465)',
    description: 'Яндекс.Почта через SMTPS (SSL) на 465.',
    host: 'smtp.yandex.ru',
    port: 465,
    wrapperSSL: true,
    hint: 'В настройках Яндекс.Почты включи «Доступ по IMAP/SMTP по паролю приложения» и создай отдельный пароль.',
  },
  {
    key: 'mailru',
    name: 'Mail.ru (smtp.mail.ru:465)',
    description: 'Mail.ru через SMTPS (SSL) на 465.',
    host: 'smtp.mail.ru',
    port: 465,
    wrapperSSL: true,
    hint: 'В настройках Mail.ru включи «Пароли для внешних приложений» и используй сгенерированный пароль.',
  },
  {
    key: 'mailgun',
    name: 'Mailgun (smtp.mailgun.org:587)',
    description: 'Mailgun SMTP, рекомендуется для рассыльных доменов.',
    host: 'smtp.mailgun.org',
    port: 587,
    wrapperSSL: false,
    hint: 'Username вида postmaster@mg.yourdomain.com, пароль — SMTP credentials из дашборда Mailgun.',
  },
  {
    key: 'sendgrid',
    name: 'SendGrid (smtp.sendgrid.net:587)',
    description: 'SendGrid SMTP API.',
    host: 'smtp.sendgrid.net',
    port: 587,
    wrapperSSL: false,
    defaultUsername: 'apikey',
    hint: 'Username всегда `apikey`. Password — это сам API key (начинается с `SG.`).',
  },
  {
    key: 'custom',
    name: 'Произвольный SMTP',
    description: 'Любой свой relay (например smtp.example.com:587).',
    host: '',
    port: 587,
    wrapperSSL: false,
  },
] as const;

export interface RelayConfig {
  preset: string;
  host: string;
  port: number;
  wrapperSSL: boolean;
  username: string;
  /** SMTP-пароль / app password / API key. Никогда не возвращается через API наружу. */
  password: string;
  /** From: для всех системных писем. Обычно равен username. */
  fromEmail: string;
  /** Куда форвардить root@/postmaster@ (через /etc/aliases). */
  adminEmail: string;
  /** Hostname HELO — обычно FQDN сервера. */
  myhostname: string;
}

export interface RelayState {
  configured: boolean;
  preset: string | null;
  host: string | null;
  port: number | null;
  wrapperSSL: boolean | null;
  username: string | null;
  /** Пароля наружу не отдаём — только наличие. */
  hasPassword: boolean;
  fromEmail: string | null;
  adminEmail: string | null;
  myhostname: string | null;
  mainCfPath: string;
  saslPasswdPath: string;
}

export class PostfixExecutor {
  constructor(private readonly cmd: CommandExecutor) {}

  // =====================================================================
  // Server level
  // =====================================================================

  async serverStatus(): Promise<ServerStatus> {
    const r = await this.cmd.execute('dpkg-query', ['-s', 'postfix'], { allowFailure: true });
    if (r.exitCode !== 0 || !r.stdout) return { installed: false, version: null };
    const status = /^Status:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() || '';
    if (!/install ok installed/.test(status)) return { installed: false, version: null };
    const version = /^Version:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() || null;
    return { installed: true, version };
  }

  /**
   * Установка postfix. Без debconf-preseed apt пытается открыть TUI-диалог
   * и зависает. Преселектим `No configuration` — мы всё равно перепишем
   * main.cf руками после установки relay.
   */
  async serverInstall(): Promise<{ version: string }> {
    const update = await this.cmd.execute(
      'apt-get',
      ['-o', 'Acquire::Retries=3', 'update'],
      { timeout: 180_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (update.exitCode !== 0) {
      throw new Error(`apt-get update failed: ${update.stderr || update.stdout}`);
    }

    // Preseed для postfix: без интерактивных вопросов.
    const preseed = [
      'postfix postfix/main_mailer_type select No configuration',
      'postfix postfix/mailname string localhost',
    ].join('\n') + '\n';
    const preseedFile = path.join(os.tmpdir(), `meowbox-postfix-preseed.${process.pid}.${Date.now()}`);
    await fs.writeFile(preseedFile, preseed, { mode: 0o600 });
    try {
      const setSel = await this.cmd.execute('debconf-set-selections', [preseedFile], {
        timeout: 15_000,
        env: { DEBIAN_FRONTEND: 'noninteractive' },
        allowFailure: true,
      });
      if (setSel.exitCode !== 0) {
        // Не критично — продолжаем, apt-get может всё равно справиться с -y.
      }
    } finally {
      await fs.unlink(preseedFile).catch(() => {});
    }

    const install = await this.cmd.execute(
      'apt-get',
      ['install', '-y', '--no-install-recommends', 'postfix', 'libsasl2-modules', 'bsd-mailx', 'ca-certificates'],
      { timeout: 600_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (install.exitCode !== 0) {
      throw new Error(`apt-get install postfix failed: ${install.stderr || install.stdout}`);
    }
    // enable, но не start — без relay-конфига postfix всё равно бесполезен.
    // Сервис включаем и стартанём после applyRelay().
    await this.cmd.execute('systemctl', ['enable', 'postfix.service'], { allowFailure: true })
      .catch(() => {});

    const status = await this.serverStatus();
    if (!status.installed) throw new Error('postfix не установился (dpkg-query != installed)');
    return { version: status.version || 'unknown' };
  }

  async serverUninstall(): Promise<void> {
    await this.cmd.execute('systemctl', ['disable', '--now', 'postfix.service'], { allowFailure: true })
      .catch(() => {});
    // Стираем sensitive-файлы (sasl_passwd содержит пароль в plain text + .db).
    for (const p of [SASL_PASSWD, `${SASL_PASSWD}.db`, GENERIC_MAP, `${GENERIC_MAP}.db`]) {
      await fs.unlink(p).catch(() => {});
    }
    const r = await this.cmd.execute(
      'apt-get',
      ['purge', '-y', 'postfix'],
      { timeout: 300_000, env: { DEBIAN_FRONTEND: 'noninteractive' }, allowFailure: true },
    );
    if (r.exitCode !== 0) {
      throw new Error(`apt-get purge postfix failed: ${r.stderr || r.stdout}`);
    }
  }

  // =====================================================================
  // Relay configuration
  // =====================================================================

  /** Каталог пресетов (статика). Используется UI для отрисовки селекта. */
  getPresetsCatalog(): RelayPreset[] {
    // Пароли в каталоге нет — только хосты/порты/подсказки.
    return POSTFIX_RELAY_PRESETS.map((p) => ({ ...p }));
  }

  /**
   * Текущее состояние relay. **Никогда не возвращает пароль**, только
   * `hasPassword: boolean` — чтобы юзер видел «настроено» без раскрытия секрета.
   */
  async getRelayState(): Promise<RelayState> {
    const out: RelayState = {
      configured: false,
      preset: null,
      host: null,
      port: null,
      wrapperSSL: null,
      username: null,
      hasPassword: false,
      fromEmail: null,
      adminEmail: null,
      myhostname: null,
      mainCfPath: MAIN_CF,
      saslPasswdPath: SASL_PASSWD,
    };

    const mainCf = await fs.readFile(MAIN_CF, 'utf-8').catch(() => '');
    if (!mainCf) return out;

    const meowboxManaged = mainCf.includes(MEOWBOX_MARK);
    const relayhost = this.readMainParam(mainCf, 'relayhost');
    const myhostname = this.readMainParam(mainCf, 'myhostname');
    const wrapper = this.readMainParam(mainCf, 'smtp_tls_wrappermode');

    if (relayhost) {
      // relayhost в формате `[host]:port`
      const m = /^\[([^\]]+)\]:(\d+)$/.exec(relayhost);
      if (m) {
        out.host = m[1];
        out.port = Number(m[2]);
      } else {
        out.host = relayhost;
      }
    }
    if (myhostname) out.myhostname = myhostname;
    out.wrapperSSL = wrapper ? /^yes$/i.test(wrapper) : false;

    // sasl_passwd — читаем username, не пароль.
    const saslExists = await fs.access(SASL_PASSWD).then(() => true).catch(() => false);
    if (saslExists) {
      const saslContent = await fs.readFile(SASL_PASSWD, 'utf-8').catch(() => '');
      // Формат: `[host]:port username:password`
      const m = /^\[[^\]]+\]:\d+\s+([^:]+):(.+)$/m.exec(saslContent);
      if (m) {
        out.username = m[1].trim();
        out.hasPassword = m[2].trim().length > 0;
      }
    }

    // From-canonical из /etc/postfix/generic
    const genericContent = await fs.readFile(GENERIC_MAP, 'utf-8').catch(() => '');
    if (genericContent) {
      // ищем последнюю строку вида `root@<host>  <fromEmail>` (без комментариев)
      const lines = genericContent.split(/\r?\n/);
      for (const ln of lines) {
        const t = ln.trim();
        if (!t || t.startsWith('#')) continue;
        const m = /^\S+\s+(\S+@\S+)$/.exec(t);
        if (m) {
          out.fromEmail = m[1];
        }
      }
    }

    // root alias из /etc/aliases
    const aliasesContent = await fs.readFile(ALIASES, 'utf-8').catch(() => '');
    if (aliasesContent) {
      const m = /^root:\s*(.+)$/m.exec(aliasesContent);
      if (m) out.adminEmail = m[1].trim();
    }

    // Восстанавливаем preset эвристически — по host. Если кастомный — 'custom'.
    if (out.host) {
      const found = POSTFIX_RELAY_PRESETS.find((p) => p.host === out.host);
      out.preset = found ? found.key : 'custom';
    }

    out.configured = meowboxManaged && !!out.host && !!out.username && out.hasPassword;
    return out;
  }

  /**
   * Применить relay-конфиг: переписать main.cf, sasl_passwd, generic, aliases.
   * Атомарно: бэкапим всё, при падении restart'а откатываем.
   */
  async applyRelay(cfg: RelayConfig): Promise<{ paths: string[]; restart: { unit: string; ok: boolean; output: string } }> {
    const safe = this.validateConfig(cfg);

    // Бэкапы — собираем сюда чтобы откатить при падении restart.
    const backups: Array<{ path: string; backupPath: string }> = [];
    const writtenPaths: string[] = [];

    try {
      // 1. main.cf — null-client + relay
      const mainCfContent = this.renderMainCf(safe);
      const mainCfBackup = await this.backupFile(MAIN_CF);
      if (mainCfBackup) backups.push({ path: MAIN_CF, backupPath: mainCfBackup });
      await this.atomicWrite(MAIN_CF, mainCfContent, 0o644);
      writtenPaths.push(MAIN_CF);

      // 2. sasl_passwd (0600) + postmap
      const saslContent = `[${safe.host}]:${safe.port} ${safe.username}:${safe.password}\n`;
      const saslBackup = await this.backupFile(SASL_PASSWD);
      if (saslBackup) backups.push({ path: SASL_PASSWD, backupPath: saslBackup });
      await this.atomicWrite(SASL_PASSWD, saslContent, 0o600);
      writtenPaths.push(SASL_PASSWD);
      const postmapSasl = await this.cmd.execute('postmap', [SASL_PASSWD], { timeout: 15_000, allowFailure: true });
      if (postmapSasl.exitCode !== 0) {
        throw new Error(`postmap ${SASL_PASSWD} failed: ${postmapSasl.stderr || postmapSasl.stdout}`);
      }
      // Подстрахуемся: .db тоже 0600 (root:root).
      await fs.chmod(`${SASL_PASSWD}.db`, 0o600).catch(() => {});

      // 3. generic-map (canonical sender) — `root@hostname → fromEmail`
      const genericContent = this.renderGeneric(safe);
      const genericBackup = await this.backupFile(GENERIC_MAP);
      if (genericBackup) backups.push({ path: GENERIC_MAP, backupPath: genericBackup });
      await this.atomicWrite(GENERIC_MAP, genericContent, 0o644);
      writtenPaths.push(GENERIC_MAP);
      const postmapGen = await this.cmd.execute('postmap', [GENERIC_MAP], { timeout: 15_000, allowFailure: true });
      if (postmapGen.exitCode !== 0) {
        throw new Error(`postmap ${GENERIC_MAP} failed: ${postmapGen.stderr || postmapGen.stdout}`);
      }

      // 4. /etc/aliases — добавляем/обновляем root: adminEmail
      const aliasesBackup = await this.backupFile(ALIASES);
      if (aliasesBackup) backups.push({ path: ALIASES, backupPath: aliasesBackup });
      await this.upsertRootAlias(safe.adminEmail);
      writtenPaths.push(ALIASES);
      await this.cmd.execute('newaliases', [], { timeout: 15_000, allowFailure: true })
        .catch(() => {});

      // 5. restart postfix
      const r = await this.cmd.execute('systemctl', ['restart', 'postfix.service'], {
        timeout: 60_000,
        allowFailure: true,
      });
      if (r.exitCode !== 0) {
        await this.rollback(backups);
        const status = await this.cmd.execute('systemctl', ['status', 'postfix.service', '--no-pager', '--lines=30'], {
          timeout: 15_000,
          allowFailure: true,
        });
        throw new Error(
          `systemctl restart postfix failed (exit ${r.exitCode}), конфиг откатили. ` +
          `stderr: ${r.stderr.trim()}\n--- status ---\n${status.stdout}`,
        );
      }

      return {
        paths: writtenPaths,
        restart: { unit: 'postfix.service', ok: true, output: r.stdout || r.stderr || '' },
      };
    } catch (err) {
      // Если что-то упало ДО restart — тоже откатываем, чтобы не оставить
      // полу-применённый конфиг (например, sasl_passwd новый, main.cf старый).
      await this.rollback(backups);
      throw err;
    }
  }

  /**
   * Отправить тестовое письмо через sendmail.
   * Читает последние 50 строк /var/log/mail.log через 1.5 сек — даёт юзеру
   * наглядный результат (отправлено / отбито).
   */
  async sendTestEmail(toEmail: string): Promise<{ sent: boolean; log: string }> {
    const to = this.sanitizeEmail(toEmail);
    if (!to) throw new Error('Некорректный адрес получателя');

    const state = await this.getRelayState();
    if (!state.configured) {
      throw new Error('Postfix не сконфигурирован для отправки. Сначала настрой relay на странице сервисов.');
    }

    const body = [
      `From: ${state.fromEmail || 'root'}`,
      `To: ${to}`,
      `Subject: meowbox test email`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      '',
      `Это тестовое письмо от панели meowbox.`,
      `Если ты его видишь — relay через ${state.host}:${state.port} работает.`,
      ``,
      `Отправлено: ${new Date().toISOString()}`,
    ].join('\n');

    // CommandExecutor.execute() не поддерживает подачу stdin-данных
    // (execFile не имеет input-опции), поэтому здесь делаем прямой spawn.
    // Аргументы фиксированные (`-i -t`), инжекции невозможны — всё тело
    // передаётся через STDIN, postfix парсит заголовки и адресатов из него.
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/sbin/sendmail', ['-i', '-t'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
      child.on('error', (err) => reject(new Error(`sendmail spawn error: ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`sendmail failed (exit ${code}): ${stderr.trim()}`));
      });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 30_000);
      child.on('close', () => clearTimeout(timer));
      child.stdin.write(body);
      child.stdin.end();
    });

    // Дать postfix время доставить / отбить.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Логи mail.log — best-effort.
    const log = await this.cmd.execute('tail', ['-n', '50', '/var/log/mail.log'], {
      timeout: 5_000,
      allowFailure: true,
    });
    return { sent: true, log: log.stdout || log.stderr || '' };
  }

  // =====================================================================
  // helpers
  // =====================================================================

  private validateConfig(c: RelayConfig): RelayConfig {
    const host = this.sanitizeHost(c.host);
    if (!host) throw new Error('host: пусто или некорректный формат (ожидается домен/IP без пробелов)');
    const port = Number(c.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`port: ${c.port} — ожидается целое число 1..65535`);
    }
    const username = this.sanitizeSimpleString(c.username, 256);
    if (!username) throw new Error('username: пусто');
    const password = String(c.password ?? '');
    if (!password) throw new Error('password: пусто');
    if (password.includes('\n') || password.includes('\r')) {
      throw new Error('password: не должен содержать переводов строк');
    }
    const fromEmail = this.sanitizeEmail(c.fromEmail);
    if (!fromEmail) throw new Error('fromEmail: некорректный email');
    const adminEmail = this.sanitizeEmail(c.adminEmail);
    if (!adminEmail) throw new Error('adminEmail: некорректный email');
    const myhostname = this.sanitizeHost(c.myhostname || os.hostname());
    if (!myhostname) throw new Error('myhostname: некорректный hostname');
    const preset = this.sanitizeSimpleString(c.preset || 'custom', 32) || 'custom';

    return {
      preset,
      host,
      port,
      wrapperSSL: !!c.wrapperSSL,
      username,
      password,
      fromEmail,
      adminEmail,
      myhostname,
    };
  }

  private renderMainCf(c: RelayConfig): string {
    const lines: string[] = [];
    lines.push(MEOWBOX_MARK);
    lines.push(`# Generated by meowbox panel at ${new Date().toISOString()}`);
    lines.push(`# Postfix configured as null-client (relay-only, no local delivery).`);
    lines.push('');
    lines.push(`compatibility_level = 3.6`);
    lines.push('');
    lines.push(`# --- Identity ---`);
    lines.push(`myhostname = ${c.myhostname}`);
    lines.push(`myorigin = $myhostname`);
    lines.push(`mydestination =`);
    lines.push(`local_recipient_maps =`);
    lines.push(`local_transport = error: local mail delivery disabled (relay-only setup)`);
    lines.push('');
    lines.push(`# --- Network ---`);
    lines.push(`inet_interfaces = loopback-only`);
    lines.push(`inet_protocols = all`);
    lines.push(`mynetworks = 127.0.0.0/8 [::1]/128`);
    lines.push('');
    lines.push(`# --- Relay (smarthost) ---`);
    lines.push(`relayhost = [${c.host}]:${c.port}`);
    lines.push(`smtp_sasl_auth_enable = yes`);
    lines.push(`smtp_sasl_password_maps = hash:${SASL_PASSWD}`);
    lines.push(`smtp_sasl_security_options = noanonymous`);
    lines.push(`smtp_sasl_tls_security_options = noanonymous`);
    lines.push('');
    lines.push(`# --- TLS ---`);
    if (c.wrapperSSL) {
      // SMTPS (порт 465) — TLS оборачивает соединение с первого байта.
      lines.push(`smtp_tls_wrappermode = yes`);
      lines.push(`smtp_tls_security_level = encrypt`);
    } else {
      // STARTTLS — обязательное шифрование.
      lines.push(`smtp_tls_security_level = encrypt`);
    }
    lines.push(`smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt`);
    lines.push(`smtp_tls_loglevel = 1`);
    lines.push('');
    lines.push(`# --- Canonical sender ---`);
    lines.push(`smtp_generic_maps = hash:${GENERIC_MAP}`);
    lines.push('');
    lines.push(`# --- Queue / mailbox (irrelevant for null-client, но Postfix requires) ---`);
    lines.push(`mailbox_size_limit = 0`);
    lines.push(`recipient_delimiter = +`);
    lines.push(`alias_maps = hash:/etc/aliases`);
    lines.push(`alias_database = hash:/etc/aliases`);
    lines.push('');
    return lines.join('\n');
  }

  private renderGeneric(c: RelayConfig): string {
    const lines: string[] = [];
    lines.push(MEOWBOX_MARK);
    lines.push(`# Generic canonical sender map — maps local senders to ${c.fromEmail}`);
    lines.push(`# чтобы relay-SMTP не отбивал письма по SPF.`);
    lines.push('');
    // Маппим всё что отправляется с локального hostname на fromEmail.
    lines.push(`root@${c.myhostname}\t${c.fromEmail}`);
    lines.push(`@${c.myhostname}\t${c.fromEmail}`);
    lines.push(`root@localhost\t${c.fromEmail}`);
    lines.push(`root\t${c.fromEmail}`);
    return lines.join('\n') + '\n';
  }

  /**
   * Идемпотентно обновляет строку `root: <email>` в /etc/aliases.
   * Если строка есть — заменяет. Иначе — добавляет в конец.
   */
  private async upsertRootAlias(adminEmail: string): Promise<void> {
    let content = await fs.readFile(ALIASES, 'utf-8').catch(() => '');
    if (!content.endsWith('\n')) content += '\n';

    const rootRegex = /^root:.*$/m;
    const newLine = `root: ${adminEmail}`;
    if (rootRegex.test(content)) {
      content = content.replace(rootRegex, newLine);
    } else {
      content += `${newLine}\n`;
    }
    await this.atomicWrite(ALIASES, content, 0o644);
  }

  private async backupFile(p: string): Promise<string | null> {
    const exists = await fs.access(p).then(() => true).catch(() => false);
    if (!exists) return null;
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${p}.meowbox.bak.${ts}`;
      await fs.copyFile(p, backupPath);
      return backupPath;
    } catch {
      return null;
    }
  }

  /**
   * Откат всех бэкапов — best-effort. Используется при падении restart'а.
   * Никаких throw — даже если что-то не откатится, остальное всё равно
   * восстанавливаем. После rollback всегда пытаемся рестартануть postfix
   * чтобы вернуть демон в рабочее состояние.
   */
  private async rollback(backups: Array<{ path: string; backupPath: string }>): Promise<void> {
    for (const { path: target, backupPath } of backups) {
      await fs.copyFile(backupPath, target).catch(() => {});
    }
    // postmap — пересоберём индексы из откаченных файлов.
    await this.cmd.execute('postmap', [SASL_PASSWD], { timeout: 15_000, allowFailure: true })
      .catch(() => {});
    await this.cmd.execute('postmap', [GENERIC_MAP], { timeout: 15_000, allowFailure: true })
      .catch(() => {});
    await this.cmd.execute('newaliases', [], { timeout: 15_000, allowFailure: true })
      .catch(() => {});
    // Перезапуск с откаченным конфигом.
    await this.cmd.execute('systemctl', ['restart', 'postfix.service'], { timeout: 60_000, allowFailure: true })
      .catch(() => {});
  }

  /** Атомарная запись: tmp в той же директории → rename. */
  private async atomicWrite(target: string, content: string, mode: number): Promise<void> {
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const tmp = `${target}.meowbox.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, content, { encoding: 'utf-8', mode });
    await fs.chmod(tmp, mode).catch(() => {});
    await fs.rename(tmp, target);
  }

  /** Парсит main.cf — возвращает значение параметра (последнее, если несколько). */
  private readMainParam(content: string, key: string): string | null {
    const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*=\\s*(.+?)\\s*$`, 'gm');
    let last: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      last = m[1];
    }
    return last;
  }

  private sanitizeHost(s: string | undefined | null): string {
    if (!s) return '';
    const t = String(s).trim();
    // host = домен или IP, без пробелов, кавычек, спецсимволов
    if (!/^[A-Za-z0-9._\-:]{1,253}$/.test(t)) return '';
    return t;
  }

  private sanitizeEmail(s: string | undefined | null): string {
    if (!s) return '';
    const t = String(s).trim();
    if (t.length > 254) return '';
    // Простой проверочный regex — не RFC5321, но отсекает мусор и инъекции.
    if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(t)) return '';
    return t;
  }

  private sanitizeSimpleString(s: string | undefined | null, max: number): string {
    if (!s) return '';
    const t = String(s).trim();
    if (!t || t.length > max) return '';
    // Запрещаем переводы строк, табы, кавычки — иначе можно инжектнуть в main.cf.
    if (/[\n\r\t"'\\`]/.test(t)) return '';
    return t;
  }
}
