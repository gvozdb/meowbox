import { CommandExecutor } from '../command-executor';
import { LETSENCRYPT_LIVE_DIR, CUSTOM_SSL_DIR } from '../config';
import * as fsp from 'fs/promises';
import * as path from 'path';

interface IssueSslParams {
  domain: string;
  domains: string[];
  rootPath: string;
  /**
   * Относительный путь к веб-файлам внутри `rootPath` (по умолчанию `www`).
   * ВАЖНО: должен точно совпадать с тем, что прописано в nginx-конфиге сайта,
   * иначе certbot положит challenge в одну директорию, а nginx будет искать
   * его в другой → 404. См. `agent/src/nginx/templates.ts::resolveWebRoot`.
   */
  filesRelPath?: string;
  email?: string;
}

interface SslResult {
  success: boolean;
  certPath?: string;
  keyPath?: string;
  expiresAt?: string;
  /**
   * Фактический список доменов в SAN выпущенного/установленного сертификата.
   * Парсится из файла cert'а через openssl — это единственный truthful источник.
   * API сохраняет его в SslCertificate.domains и по нему же считает missing-SAN
   * для UI. Если парс не удался — поле undefined, API оставит старое значение.
   */
  domains?: string[];
  error?: string;
}

/**
 * Manages SSL certificates via certbot (Let's Encrypt).
 * Uses webroot authentication for zero-downtime issuance.
 */
export class SslManager {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  /**
   * Issue/renew SSL certificate using certbot webroot mode.
   */
  async issueCertificate(params: IssueSslParams): Promise<SslResult> {
    const { domain, domains, rootPath, filesRelPath, email } = params;
    // Webroot ДОЛЖЕН совпадать с nginx `root` для `.well-known/acme-challenge/`.
    // Сан-логика дублирует resolveWebRoot() из nginx/templates.ts: убираем
    // ведущие/трейлинг слэши и `..`, fallback — `www`.
    const rel = (filesRelPath || 'www').replace(/^\/+/, '').replace(/\.\.+/g, '').replace(/\/+$/, '') || 'www';
    const webroot = `${rootPath}/${rel}`;

    // Build certbot args.
    // --expand ВАЖЕН: если серт с --cert-name уже существует и список -d
    // отличается (добавили/убрали алиас) — без --expand certbot в
    // --non-interactive падает с ошибкой "requires --expand". С ним —
    // переиздаёт с новым SAN, что нам и нужно для кнопки «Перевыпустить».
    const args = [
      'certonly',
      '--webroot',
      '--webroot-path', webroot,
      '--agree-tos',
      '--non-interactive',
      '--expand',
      '--cert-name', domain,
    ];

    // Add email or register non-interactively
    if (email) {
      args.push('--email', email);
    } else {
      args.push('--register-unsafely-without-email');
    }

    // Add all domains
    for (const d of domains) {
      args.push('-d', d);
    }

    const result = await this.executor.execute('certbot', args, {
      timeout: 120_000,
      allowFailure: true,
    });

    // Чистим .well-known/acme-challenge от мусора, оставшегося после валидации.
    // Если ACME упал — challenge-файлы всё равно не нужны (certbot их пересоздаст
    // при следующей попытке). Если выпустили — тем более не нужны.
    // Саму директорию .well-known удаляем только если она пустая после чистки,
    // чтобы не удалить чужие файлы (security.txt и т.п., которые юзер мог положить).
    await this.cleanupAcmeChallenge(webroot);

    if (result.exitCode !== 0) {
      // Certbot 2.x пишет понятные ошибки в STDOUT, а не STDERR — парсим оба.
      const raw = `${result.stdout}\n${result.stderr}`.trim();
      const parsed = this.parseCertbotError(raw);
      // Если парсер ничего полезного не нашёл (редкий случай: rate-limit
      // без output, SIGKILL без stderr), всё равно даём наружу что-то
      // диагностируемое — exitCode + первые 400 символов raw output.
      const fallback = `certbot exit ${result.exitCode}${raw ? ': ' + raw.substring(0, 400) : ''}`;
      return {
        success: false,
        error: parsed && parsed !== 'Certbot failed' ? parsed : fallback,
      };
    }

    // Get certificate info
    const certPath = `${LETSENCRYPT_LIVE_DIR}/${domain}/fullchain.pem`;
    const keyPath = `${LETSENCRYPT_LIVE_DIR}/${domain}/privkey.pem`;

    // Get expiry date
    const expiresAt = await this.getCertExpiry(certPath);
    const sanDomains = await this.readCertSan(certPath);

    return {
      success: true,
      certPath,
      keyPath,
      expiresAt,
      domains: sanDomains,
    };
  }

  /**
   * Renew all certificates that are close to expiration.
   */
  async renewAll(): Promise<{ success: boolean; output: string }> {
    const result = await this.executor.execute('certbot', ['renew', '--quiet'], {
      timeout: 300_000,
      allowFailure: true,
    });

    return {
      success: result.exitCode === 0,
      output: result.stdout + result.stderr,
    };
  }

  /**
   * Проверить и подхватить уже лежащий на диске сертификат.
   * Читает /etc/letsencrypt/live/DOMAIN/fullchain.pem, достаёт notAfter
   * через openssl. Нужен для UI-кнопки «Импортировать существующий серт».
   */
  async inspectExisting(
    domain: string,
  ): Promise<{ success: boolean; found: boolean; certPath?: string; keyPath?: string; expiresAt?: string; domains?: string[]; error?: string }> {
    if (!/^[A-Za-z0-9.-]+$/.test(domain) || domain.includes('..')) {
      return { success: false, found: false, error: 'Invalid domain name' };
    }
    const certPath = `${LETSENCRYPT_LIVE_DIR}/${domain}/fullchain.pem`;
    const keyPath = `${LETSENCRYPT_LIVE_DIR}/${domain}/privkey.pem`;
    try {
      const { access } = await import('fs/promises');
      await access(certPath);
      await access(keyPath);
    } catch {
      return { success: true, found: false };
    }
    // Читаем notAfter через openssl.
    const openssl = await this.executor.execute('openssl', [
      'x509', '-in', certPath, '-noout', '-enddate',
    ], { allowFailure: true });
    let expiresAt: string | undefined;
    if (openssl.exitCode === 0) {
      const match = openssl.stdout.match(/notAfter=(.+)/);
      if (match) {
        try { expiresAt = new Date(match[1]).toISOString(); } catch { /* ignore */ }
      }
    }
    const sanDomains = await this.readCertSan(certPath);
    return { success: true, found: true, certPath, keyPath, expiresAt, domains: sanDomains } as
      { success: true; found: true; certPath: string; keyPath: string; expiresAt?: string; domains?: string[] };
  }

  /**
   * Revoke and delete a certificate.
   *
   * Семантика — «удалить серт с диска и попытаться отозвать в LE». Делаем в
   * таком порядке, потому что:
   *   - `certbot revoke` фейлится для МИГРИРОВАННЫХ сертов (account
   *     mismatch — серт принадлежит LE-аккаунту исходного сервера) и для
   *     уже отозванных. Если оставить только revoke, LE-папка остаётся
   *     на диске → следующая миграция/выпуск этого же домена ловит
   *     «уже существует» и фейлится. Поэтому rm всегда, даже при фейле revoke.
   *   - Сначала revoke (если получится — LE-серт реально аннулируется на ACME),
   *     потом force-rm как safety net.
   *
   * Идемпотентно: повторный вызов на уже снесённой папке — no-op.
   */
  async revokeCertificate(domain: string): Promise<{ success: boolean }> {
    // Базовый sanity-check на имя домена — не пускаем `..` и слеши, чтобы
    // rm не ушёл по какому-то traversal.
    if (!/^[A-Za-z0-9.-]+$/.test(domain) || domain.includes('..')) {
      return { success: false };
    }

    const live = `${LETSENCRYPT_LIVE_DIR}/${domain}`;
    const archive = `/etc/letsencrypt/archive/${domain}`;
    const renewal = `/etc/letsencrypt/renewal/${domain}.conf`;
    const certPath = `${live}/fullchain.pem`;

    // 1) Пытаемся отозвать через certbot. Падает на migrated/уже-revoked сертах —
    // не считаем это ошибкой: главное — почистить файлы.
    let revokeOk = false;
    try {
      const liveExists = await fsp.stat(certPath).then(() => true).catch(() => false);
      if (liveExists) {
        const result = await this.executor.execute('certbot', [
          'revoke',
          '--cert-path', certPath,
          '--non-interactive',
          '--delete-after-revoke',
        ], { timeout: 60_000, allowFailure: true });
        revokeOk = result.exitCode === 0;
      }
    } catch { /* проглатываем — переходим к force-cleanup */ }

    // 2) Force-cleanup LE-артефактов. Если certbot уже всё удалил — это no-op.
    // Если revoke фейлнулся — мы всё равно сносим папки, иначе следующая миграция
    // зафейлится на «уже существует на slave».
    await fsp.rm(live, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(archive, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(renewal, { force: true }).catch(() => {});

    return { success: revokeOk };
  }

  /**
   * Install a custom SSL certificate (user-provided cert + key).
   */
  async installCustomCertificate(params: {
    domain: string;
    certPem: string;
    keyPem: string;
    chainPem?: string;
  }): Promise<SslResult> {
    const { domain, certPem, keyPem, chainPem } = params;
    // Базовый sanity-check на имя домена — чтобы не получить traversal через
    // `..` или слеши, которые подмешают путь в другую директорию.
    if (!/^[A-Za-z0-9.-]+$/.test(domain) || domain.includes('..')) {
      return { success: false, error: 'Invalid domain name' };
    }
    const certDir = `${CUSTOM_SSL_DIR}/${domain}`;

    try {
      await this.executor.execute('mkdir', ['-p', certDir]);

      // Write cert files
      const certPath = `${certDir}/fullchain.pem`;
      const keyPath = `${certDir}/privkey.pem`;

      // Combine cert + chain if provided
      const fullChain = chainPem ? `${certPem}\n${chainPem}` : certPem;

      const { writeFile } = await import('fs/promises');
      await writeFile(certPath, fullChain, 'utf-8');
      await writeFile(keyPath, keyPem, { encoding: 'utf-8', mode: 0o600 });

      // Restrict key permissions
      await this.executor.execute('chmod', ['600', keyPath]);
      await this.executor.execute('chown', ['root:root', certDir, '-R']);

      // Try to get expiry date using openssl (if available)
      let expiresAt: string | undefined;
      const openssl = await this.executor.execute('openssl', [
        'x509', '-in', certPath, '-noout', '-enddate',
      ], { allowFailure: true });
      if (openssl.exitCode === 0) {
        const match = openssl.stdout.match(/notAfter=(.+)/);
        if (match) {
          try { expiresAt = new Date(match[1]).toISOString(); } catch { /* ignore */ }
        }
      }

      const sanDomains = await this.readCertSan(certPath);
      return { success: true, certPath, keyPath, expiresAt, domains: sanDomains };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Парсит SAN из PEM-сертификата через openssl.
   * Возвращает массив DNS-имён (нормализованный, lowercase) или undefined,
   * если openssl отсутствует/парс не удался.
   *
   * Нам это нужно, чтобы в БД лежал РЕАЛЬНЫЙ список доменов из серта, а не
   * "что мы передавали в --domains при выпуске". Эти два списка могут
   * разойтись: например, admin вручную удалил какой-то -d через certbot CLI,
   * или на ssl:install-custom пользователь прислал кастомный серт с
   * другим набором SAN.
   */
  private async readCertSan(certPath: string): Promise<string[] | undefined> {
    try {
      const r = await this.executor.execute('openssl', [
        'x509', '-in', certPath, '-noout', '-ext', 'subjectAltName',
      ], { timeout: 10_000, allowFailure: true });
      if (r.exitCode !== 0) return undefined;
      // Вывод выглядит так:
      //   X509v3 Subject Alternative Name:
      //       DNS:mods.gvozdb.ru, DNS:pkgs.gvozdb.ru
      const dnsNames: string[] = [];
      for (const m of r.stdout.matchAll(/DNS:([^,\s]+)/g)) {
        dnsNames.push(m[1].toLowerCase());
      }
      return dnsNames.length ? Array.from(new Set(dnsNames)) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Достаёт из вывода certbot человеко-читабельную причину фэйла.
   *
   * Certbot 2.x пишет в таком формате:
   *   Certbot failed to authenticate some domains (authenticator: webroot). ...
   *     Domain: example.com
   *     Type:   unauthorized
   *     Detail: 1.2.3.4: Invalid response from http://.../.well-known/...: 403
   *   Hint: The Certificate Authority failed to download ...
   *   Some challenges have failed.
   *
   * Раньше мы просто отдавали последнюю строчку «Some challenges have failed» —
   * бесполезно. Теперь вытаскиваем пары Domain/Type/Detail и приклеиваем Hint.
   * Если ничего не распарсилось — отдаём очищенный вывод как есть.
   */
  private parseCertbotError(raw: string): string {
    if (!raw) return '';

    const lines = raw.split('\n').map((l) => l.trim());

    // 1) Rate limit Let's Encrypt — самая частая причина на тесте.
    const rateLimit = lines.find((l) => /rate ?limit|too many (certificates|failed)/i.test(l));
    if (rateLimit) return `Let's Encrypt rate limit: ${rateLimit}`;

    // 2) DNS / NXDOMAIN.
    const dns = lines.find((l) =>
      /DNS problem|NXDOMAIN|no (A|AAAA) record|could not resolve/i.test(l),
    );
    if (dns) return `DNS: ${dns}`;

    // 3) Пары Domain/Type/Detail — основная диагностика от ACME.
    const blocks: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^Domain:\s*(.+)$/i.exec(lines[i]);
      if (!m) continue;
      const domain = m[1];
      let type = '';
      let detail = '';
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const t = /^Type:\s*(.+)$/i.exec(lines[j]);
        const d = /^Detail:\s*(.+)$/i.exec(lines[j]);
        if (t) type = t[1];
        if (d) detail = d[1];
      }
      if (type || detail) {
        blocks.push(`${domain}: ${type}${type && detail ? ' — ' : ''}${detail}`);
      }
    }

    // 4) Hint от certbot — практический совет.
    const hintIdx = lines.findIndex((l) => /^Hint:\s*/i.test(l));
    let hint = '';
    if (hintIdx !== -1) {
      const h = [lines[hintIdx].replace(/^Hint:\s*/i, '')];
      for (let j = hintIdx + 1; j < lines.length; j++) {
        if (!lines[j] || /^(Some challenges|Saving debug log|Ask for help|See the logfile)/i.test(lines[j])) break;
        h.push(lines[j]);
      }
      hint = h.join(' ').trim();
    }

    if (blocks.length) {
      return hint ? `${blocks.join('; ')}\nHint: ${hint}` : blocks.join('; ');
    }

    // 5) Fallback — чистим boilerplate и отдаём оставшееся.
    const useful = lines
      .filter(Boolean)
      .filter(
        (line) =>
          !line.startsWith('Saving debug log') &&
          !line.startsWith('Ask for help') &&
          !line.startsWith('See the logfile') &&
          !line.includes('https://community.letsencrypt.org') &&
          !/^Some challenges have failed/i.test(line),
      );

    return useful.join('\n') || raw.trim();
  }

  /**
   * Удаляет `.well-known/acme-challenge/*` после попытки выпуска/ренью.
   * Саму `.well-known/` удаляем, только если после чистки она пустая — юзер
   * мог там держать свои файлы (security.txt, apple-app-site-association и т.п.).
   * Все ошибки тихо глотаем — чистка best-effort, не должна ломать флоу.
   */
  private async cleanupAcmeChallenge(webroot: string): Promise<void> {
    if (!webroot || !path.isAbsolute(webroot)) return;
    const wellKnown = path.join(webroot, '.well-known');
    const challenge = path.join(wellKnown, 'acme-challenge');
    try {
      await fsp.rm(challenge, { recursive: true, force: true });
    } catch { /* ignore */ }
    // Если .well-known после этого пустая — сносим её тоже.
    try {
      const rest = await fsp.readdir(wellKnown);
      if (rest.length === 0) {
        await fsp.rmdir(wellKnown);
      }
    } catch { /* .well-known могло не быть, либо там ещё что-то лежит — ок */ }
  }

  private async getCertExpiry(certPath: string): Promise<string | undefined> {
    // Use openssl to read the cert expiry
    // openssl is not in the allowlist, so we use certbot certificates
    const result = await this.executor.execute('certbot', [
      'certificates',
      '--cert-name', certPath.split('/')[4] || '',
    ], { timeout: 30_000, allowFailure: true });

    if (result.exitCode !== 0) return undefined;

    // Parse expiry from certbot output
    const expiryMatch = result.stdout.match(/Expiry Date: (.+?)(?:\s|$)/);
    if (expiryMatch) {
      try {
        return new Date(expiryMatch[1]).toISOString();
      } catch {
        return undefined;
      }
    }

    return undefined;
  }
}
