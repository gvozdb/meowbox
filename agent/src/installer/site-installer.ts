import { CommandExecutor } from '../command-executor';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  DEFAULT_MODX_REVO_VERSION,
  DEFAULT_MODX_3_VERSION,
  DEFAULT_PHP_VERSION,
  modxDownloadZipUrl,
  MODX_SETUP_PHP_MEMORY_LIMIT_MB,
  MODX_DB_DEFAULTS,
} from '@meowbox/shared';
import { TIMEOUTS, HTTP_CHECK, COMPOSER_CANDIDATES } from '../config';

type LogFn = (line: string) => void;

interface InstallResult {
  success: boolean;
  error?: string;
  version?: string;
}

interface ModxInstallParams {
  rootPath: string;
  filesRelPath?: string; // относительный путь до web-root (обычно "www")
  domain: string;
  phpVersion: string;
  modxVersion?: string; // "2.8.8-pl", "3.1.2-pl" и т.п.
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbType: 'MARIADB' | 'MYSQL' | 'POSTGRESQL';
  adminUser?: string;
  adminPassword?: string;
  adminEmail?: string;
  systemUser?: string; // per-site Linux user (defaults to www-data)
  managerPath?: string;   // default: 'manager'
  connectorsPath?: string; // default: 'connectors'
}

interface ModxUpdateParams {
  rootPath: string;
  filesRelPath?: string;
  phpVersion: string;
  targetVersion: string; // обязательно — версия, на которую обновляем
  systemUser?: string;
  managerPath?: string;
  connectorsPath?: string;
}

// Дефолтные (latest) версии MODX и URL-генератор ZIP-архивов — импортированы
// из shared, чтобы api/web знали те же значения по-умолчанию.
// Сохраняем локальные алиасы, чтобы не ломать существующий код.
const DEFAULT_REVO_VERSION = DEFAULT_MODX_REVO_VERSION;
const DEFAULT_MODX3_VERSION = DEFAULT_MODX_3_VERSION;
const modxZipUrl = modxDownloadZipUrl;

/**
 * Installs CMS/frameworks when creating sites.
 *
 * - MODX Revolution (2.x) — скачиваем ZIP + CLI setup.
 * - MODX 3 — composer create-project (нативный способ), fallback на ZIP + CLI setup.
 * - CUSTOM — пустой scaffold: www/index.html.
 */
export class SiteInstaller {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  // ===========================================================================
  // MODX Revolution 2.x — только ZIP + CLI setup
  // ===========================================================================

  async installModxRevo(
    params: ModxInstallParams,
    onLog?: LogFn,
  ): Promise<InstallResult> {
    const version = params.modxVersion || DEFAULT_REVO_VERSION;
    return this.installModxFromZip(params, modxZipUrl(version), 'revo', version, onLog);
  }

  // ===========================================================================
  // MODX 3 — нативная установка через composer, fallback на ZIP
  // ===========================================================================

  async installModx3(
    params: ModxInstallParams,
    onLog?: LogFn,
  ): Promise<InstallResult> {
    const log = onLog || (() => {});
    const wwwDir = this.resolveWwwDir(params.rootPath, params.filesRelPath);
    const version = params.modxVersion || DEFAULT_MODX3_VERSION;
    const composerPackage = `modx/revolution=${version}`;

    // Pre-check: php-бинарь нужной версии существует. Если нет — это ОШИБКА,
    // не fallback. Иначе пользователь увидит "сайт создан" + пустую БД +
    // вечный 502 от nginx. cli-install.php спавнит php напрямую — `which`
    // быстрее и надёжнее, чем падение через ENOENT посередине composer'а.
    const phpBinForComposer = `php${params.phpVersion || DEFAULT_PHP_VERSION}`;
    const phpCheck = await this.executor.execute('which', [phpBinForComposer], { allowFailure: true });
    if (phpCheck.exitCode !== 0) {
      const msg = `${phpBinForComposer} не установлен на сервере. Установи "apt install ${phpBinForComposer}-cli ${phpBinForComposer}-fpm" (на Ubuntu/Debian подключи ondrej/php PPA или sury.org), либо выбери другую версию PHP при создании сайта.`;
      log(`[install] ✗ ${msg}`);
      return { success: false, error: msg };
    }

    // Проверяем composer: если нет — fallback на ZIP-инсталлер (это легитимный
    // путь, ZIP-архив самодостаточен и работает без composer).
    // ВАЖНО: composer запускаем через тот же PHP-бинарь, что и сайт (php-fpm),
    // иначе vendor/composer/platform_check.php сгенерируется под системный `php`
    // (обычно самый свежий), и runtime сайта будет падать с
    // "Your Composer dependencies require a PHP version >= 8.4.0".
    const composerPath = await this.resolveComposerPath();
    if (!composerPath) {
      log('[install] composer не найден на сервере — fallback на ZIP-архив');
      return this.installModxFromZip(params, modxZipUrl(version), '3', version, onLog);
    }
    const composerCheck = await this.executor.execute(phpBinForComposer, [composerPath, '--version'], { allowFailure: true });
    if (composerCheck.exitCode !== 0) {
      log(`[install] ${phpBinForComposer} + composer недоступен — fallback на ZIP-архив`);
      return this.installModxFromZip(params, modxZipUrl(version), '3', version, onLog);
    }

    try {
      log(`[install] MODX 3 via composer create-project (version ${version}, PHP: ${phpBinForComposer})...`);

      // Composer требует, чтобы директория либо не существовала, либо была пуста.
      // Пересоздаём wwwDir пустой.
      await this.executor.execute('rm', ['-rf', wwwDir]);
      await this.executor.execute('mkdir', ['-p', path.dirname(wwwDir)]);

      const owner = params.systemUser ? `${params.systemUser}:${params.systemUser}` : 'www-data:www-data';

      // composer create-project modx/revolution=VER <wwwDir>
      // Streaming: композер пишет прогресс пачками "Installing modx/revolution...",
      // "Downloading", "Package operations: N installs" — пусть летит в лог сразу.
      const composerResult = await this.executor.executeStreaming(
        phpBinForComposer,
        [
          composerPath,
          'create-project',
          '--no-interaction',
          '--prefer-dist',
          '--no-progress',
          composerPackage,
          wwwDir,
        ],
        {
          timeout: 600_000,
          cwd: params.rootPath,
          allowFailure: true,
          onLine: (line, stream) => {
            const prefix = stream === 'stderr' ? '[composer!] ' : '[composer] ';
            log(prefix + line);
          },
        },
      );

      if (composerResult.exitCode !== 0) {
        log(`[install] composer create-project failed: ${composerResult.stderr.substring(0, 500)}`);
        log('[install] Fallback → ZIP-архив');
        return this.installModxFromZip(params, modxZipUrl(version), '3', version, onLog);
      }

      log('[install] MODX 3 files installed via composer');

      // Пиним версию в composer.json, чтобы последующие update её знали.
      await this.executor.execute(
        phpBinForComposer,
        [composerPath, 'config', 'version', version],
        { cwd: wwwDir },
      ).catch(() => { /* не критично */ });

      // Переименовываем manager/connectors если задан кастомный путь.
      await this.renameCustomPaths(wwwDir, params, log);

      // Выставляем права доступа ДО запуска setup (он пишет файлы).
      log(`[install] Setting permissions (owner: ${owner})...`);
      await this.executor.execute('chown', ['-R', owner, params.rootPath]);
      await this.executor.execute('chmod', ['-R', '750', wwwDir]);

      for (const subdir of ['core/cache', 'core/export', 'core/packages', 'assets']) {
        const dir = path.join(wwwDir, subdir);
        try {
          await fs.access(dir);
          await this.executor.execute('chmod', ['-R', '775', dir]);
        } catch {
          // может не существовать до setup
        }
      }

      // Запускаем CLI-setup MODX 3 через cli-install.php (flat args).
      // Если cli-install и setup/index.php оба упали — это ОШИБКА установки,
      // а не успех. Раньше функция тихо писала config.inc.php вручную и возвращала
      // success=true, после чего сайт получал статус RUNNING с пустой БД.
      // Теперь честно бросаем ошибку, чтобы UI показал red ERROR.
      if (params.dbName) {
        log('[install] Running MODX 3 cli-install.php...');
        const setupResult = await this.runModx3CliInstall(wwwDir, params, log);
        if (!setupResult.success) {
          log(`[install] cli-install.php failed: ${setupResult.error}`);
          log('[install] Fallback → setup/index.php (config.xml mode)');
          const fallback = await this.runModxSetup(wwwDir, params, log);
          if (!fallback.success) {
            log(`[install] setup/index.php also failed: ${fallback.error}`);
            // Пишем config.inc.php — он позволит юзеру завершить через
            // /setup/ в браузере, но сайт всё равно ОШИБКА для UI.
            await this.writeModxConfig(wwwDir, params);
            return {
              success: false,
              error: `MODX setup упал: cli-install: ${setupResult.error}; setup/index.php: ${fallback.error}. Файлы установлены, БД не наполнена. Завершите установку через /setup/ в браузере, либо удалите сайт и пересоздайте после установки нужной версии PHP.`,
            };
          }
        }
      } else {
        log('[install] No database configured, skipping setup');
      }

      // Финальная нормализация: чистим владельца и режимы рекурсивно
      // (cli-install создавал кэш-подкаталоги от root).
      await this.finalizeModxPermissions(params.rootPath, wwwDir, params.systemUser, log);

      // Создаём per-site tmp, если указан systemUser.
      if (params.systemUser) {
        const tmpDir = path.join(params.rootPath, 'tmp');
        await this.executor.execute('mkdir', ['-p', tmpDir]);
        await this.executor.execute('chown', [owner, tmpDir]);
        await this.executor.execute('chmod', ['750', tmpDir]);
      }

      // Финальная зачистка dev-мусора из корня MODX (выполняется независимо
      // от того, как прошёл setup: cli-install / index.php / manual config).
      await this.cleanupModxDevFiles(wwwDir, log);

      log(`[install] MODX 3 ${version} installation complete`);
      return { success: true, version };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ===========================================================================
  // Обновление MODX Revo 2.x — скачиваем новый ZIP, накатываем, запускаем upgrade
  // ===========================================================================

  async updateModxRevo(params: ModxUpdateParams, onLog?: LogFn): Promise<InstallResult> {
    const log = onLog || (() => {});
    const wwwDir = this.resolveWwwDir(params.rootPath, params.filesRelPath);
    const version = params.targetVersion;

    try {
      // 1. Убеждаемся, что config.inc.php существует — иначе апгрейдить нечего.
      const configPath = path.join(wwwDir, 'core', 'config', 'config.inc.php');
      try {
        await fs.access(configPath);
      } catch {
        return { success: false, error: `config.inc.php не найден — нечего апгрейдить (${configPath})` };
      }

      // 2. Скачиваем ZIP новой версии.
      log(`[update] Downloading MODX Revo ${version}...`);
      const zipPath = path.join(params.rootPath, `modx-${version}.zip`);
      const dl = await this.executor.execute('curl', [
        '-fsSL', '-o', zipPath,
        '--connect-timeout', String(HTTP_CHECK.CONNECT),
        '--max-time', String(HTTP_CHECK.MAX_TIME),
        '-L', modxZipUrl(version),
      ], { timeout: TIMEOUTS.MEDIUM, allowFailure: true });
      if (dl.exitCode !== 0) {
        return { success: false, error: `download failed (${dl.exitCode}): ${dl.stderr.substring(0, 300)}` };
      }

      // 3. Распаковываем во временную директорию.
      const tmpDir = path.join(params.rootPath, `_modx_upgrade_${Date.now()}`);
      await this.executor.execute('mkdir', ['-p', tmpDir]);
      const ok = await this.extractZip(zipPath, tmpDir, log);
      await fs.unlink(zipPath).catch(() => {});
      if (!ok) {
        await this.executor.execute('rm', ['-rf', tmpDir]);
        return { success: false, error: 'extraction failed' };
      }

      const entries = await fs.readdir(tmpDir);
      const srcDir = entries.length === 1 ? path.join(tmpDir, entries[0]) : tmpDir;

      // 3.5. Если у сайта кастомные пути manager/connectors — переименовываем папки
      //      в srcDir ДО overlay, чтобы новые файлы легли в кастомные директории
      //      (иначе `cp -rT` создаст в корне параллельные дефолтные manager/ и connectors/,
      //      а пользовательские кастомные папки останутся со старой версией MODX).
      await this.renameSrcCustomPaths(srcDir, params.managerPath, params.connectorsPath, log);

      // 4. Накатываем файлы поверх — config.inc.php остаётся нетронутым
      //    (cp -rT перезаписывает файлы; config уже есть и не в архиве, в архиве только default).
      log('[update] Overlaying new files...');
      await this.executor.execute('cp', ['-rT', srcDir, wwwDir]);
      await this.executor.execute('rm', ['-rf', tmpDir]);

      // 5. Права.
      const owner = params.systemUser ? `${params.systemUser}:${params.systemUser}` : 'www-data:www-data';
      await this.executor.execute('chown', ['-R', owner, wwwDir]);
      await this.executor.execute('chmod', ['-R', '750', wwwDir]);
      for (const subdir of ['core/cache', 'core/export', 'core/packages', 'assets']) {
        const dir = path.join(wwwDir, subdir);
        try {
          await fs.access(dir);
          await this.executor.execute('chmod', ['-R', '775', dir]);
        } catch { /* ignore */ }
      }

      // 6. Upgrade через CLI: setup/index.php --installmode=upgrade.
      // Если CLI сработал — setup/ можно сносить безопасно. Если нет — оставляем,
      // чтобы пользователь мог завершить через браузер.
      const upgradeRes = await this.runModxUpgrade(wwwDir, params, log);
      if (!upgradeRes.success) {
        log(`[update] CLI upgrade failed: ${upgradeRes.error}`);
        log('[update] Файлы накатаны — завершите апгрейд через /setup/ в браузере');
        await this.cleanupModxDevFiles(wwwDir, log, false); // оставить setup/
      } else {
        await this.cleanupModxDevFiles(wwwDir, log, true); // грохнуть setup/
      }

      // 7. Финальная нормализация прав: апгрейдер запускался от root и
      //    мог посоздавать в core/cache/ подкаталоги root:root → еventMap
      //    больше не пересобирается, плагины глохнут.
      await this.finalizeModxPermissions(params.rootPath, wwwDir, params.systemUser, log);

      log(`[update] MODX Revo обновлён до ${version}`);
      return { success: true, version };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ===========================================================================
  // Обновление MODX 3 — через composer, fallback на ZIP overlay
  // ===========================================================================

  async updateModx3(params: ModxUpdateParams, onLog?: LogFn): Promise<InstallResult> {
    const log = onLog || (() => {});
    const wwwDir = this.resolveWwwDir(params.rootPath, params.filesRelPath);
    const version = params.targetVersion;

    try {
      const composerJson = path.join(wwwDir, 'composer.json');
      let hasComposer = false;
      try {
        await fs.access(composerJson);
        hasComposer = true;
      } catch { /* no composer.json → fallback */ }

      // Как и при install — composer запускаем через PHP сайта, чтобы
      // platform_check в vendor соответствовал runtime-версии PHP.
      const phpBinForComposer = `php${params.phpVersion || DEFAULT_PHP_VERSION}`;
      const composerPath = await this.resolveComposerPath();
      const composerCheck = composerPath
        ? await this.executor.execute(phpBinForComposer, [composerPath, '--version'], { allowFailure: true })
        : { exitCode: 1 } as { exitCode: number };
      if (!hasComposer || !composerPath || composerCheck.exitCode !== 0) {
        log(`[update] composer.json нет или composer недоступен — fallback на ZIP overlay`);
        return this.updateModxRevo({ ...params }, onLog);
      }

      log(`[update] MODX 3: переключаю composer на версию ${version} (PHP: ${phpBinForComposer})...`);

      // Обновляем зависимость через composer require (авто-апдейт).
      const req = await this.executor.executeStreaming(
        phpBinForComposer,
        [
          composerPath,
          'require',
          '--no-interaction',
          '--no-progress',
          '--update-with-dependencies',
          `modx/revolution:${version}`,
        ],
        {
          cwd: wwwDir,
          timeout: 600_000,
          allowFailure: true,
          onLine: (line, stream) => {
            const prefix = stream === 'stderr' ? '[composer!] ' : '[composer] ';
            log(prefix + line);
          },
        },
      );
      if (req.exitCode !== 0) {
        log(`[update] composer require failed: ${req.stderr.substring(0, 500)}`);
        log('[update] Fallback → ZIP overlay');
        return this.updateModxRevo({ ...params }, onLog);
      }

      // Пиним новую версию в composer.json.
      await this.executor.execute(
        phpBinForComposer,
        [composerPath, 'config', 'version', version],
        { cwd: wwwDir },
      ).catch(() => {});

      // Если у сайта кастомные пути manager/connectors — composer require вытащил
      // новые файлы в дефолтные wwwDir/manager и wwwDir/connectors. Накатываем их
      // на кастомные директории и сносим дефолтные, иначе в корне будут торчать
      // две пары папок (старая custom со старыми файлами + новая дефолтная).
      await this.mergeCustomPathsAfterOverlay(wwwDir, params.managerPath, params.connectorsPath, log);

      // Права ДО апгрейдера: composer вытащил vendor/ как root, надо забрать.
      const owner = params.systemUser ? `${params.systemUser}:${params.systemUser}` : 'www-data:www-data';
      await this.executor.execute('chown', ['-R', owner, wwwDir]);

      // Запускаем upgrade-setup.
      // composer require уже перезаписал файлы, но setup/ остаётся — его
      // надо снести отдельным шагом, иначе он будет доступен публично.
      const upgradeRes = await this.runModxUpgrade(wwwDir, params, log);
      if (!upgradeRes.success) {
        log(`[update] CLI upgrade failed: ${upgradeRes.error}`);
        log('[update] Файлы обновлены через composer — завершите апгрейд через /setup/ или manager');
        await this.cleanupModxDevFiles(wwwDir, log, false); // оставить setup/ для ручного завершения
      } else {
        await this.cleanupModxDevFiles(wwwDir, log, true);
      }

      // Финальная нормализация прав: setup/index.php --installmode=upgrade
      // запускался от root и мог насоздавать в core/cache/ подкаталоги root:root
      // → eventMap больше не пересобирается, плагины глохнут на любом событии.
      await this.finalizeModxPermissions(params.rootPath, wwwDir, params.systemUser, log);

      log(`[update] MODX 3 обновлён до ${version}`);
      return { success: true, version };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ===========================================================================
  // Общий ZIP-инсталлер (используется Revo + fallback для 3)
  // ===========================================================================

  private async installModxFromZip(
    params: ModxInstallParams,
    downloadUrl: string,
    label: 'revo' | '3',
    version: string,
    onLog?: LogFn,
  ): Promise<InstallResult> {
    const log = onLog || (() => {});

    try {
      const wwwDir = this.resolveWwwDir(params.rootPath, params.filesRelPath);
      await this.executor.execute('mkdir', ['-p', wwwDir]);

      // Step 1: Скачиваем ZIP
      log(`[install] Downloading MODX ${label} ${version}...`);
      const zipPath = path.join(params.rootPath, 'modx.zip');

      const dlResult = await this.executor.execute('curl', [
        '-fsSL',
        '-o', zipPath,
        '--connect-timeout', String(HTTP_CHECK.CONNECT),
        '--max-time', String(HTTP_CHECK.MAX_TIME),
        '-L',
        downloadUrl,
      ], { timeout: TIMEOUTS.MEDIUM, allowFailure: true });

      if (dlResult.exitCode !== 0) {
        log(`[install] Download failed (code ${dlResult.exitCode}), creating MODX-ready structure...`);
        await this.createModxStub(wwwDir, params);
        log('[install] MODX-ready structure created. Upload MODX manually or via Deploy.');
        return { success: true };
      }

      try {
        const stat = await fs.stat(zipPath);
        if (stat.size < 100_000) {
          log(`[install] Downloaded file too small (${stat.size} bytes), creating stub...`);
          await fs.unlink(zipPath).catch(() => {});
          await this.createModxStub(wwwDir, params);
          return { success: true };
        }
      } catch {
        log('[install] Downloaded file not found, creating stub...');
        await this.createModxStub(wwwDir, params);
        return { success: true };
      }

      // Step 2: Распаковка
      log('[install] Extracting...');
      const tmpDir = path.join(params.rootPath, '_modx_tmp');
      await this.executor.execute('mkdir', ['-p', tmpDir]);

      const extracted = await this.extractZip(zipPath, tmpDir, log);
      await fs.unlink(zipPath).catch(() => {});

      if (!extracted) {
        log('[install] Extraction failed, creating stub...');
        await this.executor.execute('rm', ['-rf', tmpDir]);
        await this.createModxStub(wwwDir, params);
        return { success: true };
      }

      const entries = await fs.readdir(tmpDir);
      const modxDir =
        entries.length === 1
          ? path.join(tmpDir, entries[0])
          : tmpDir;

      await this.executor.execute('cp', ['-rT', modxDir, wwwDir]);
      await this.executor.execute('rm', ['-rf', tmpDir]);
      log(`[install] MODX files extracted to ${wwwDir}`);

      // Step 2.5: Переименование manager/connectors
      await this.renameCustomPaths(wwwDir, params, log);

      // Step 3: Права ДО setup
      const owner = params.systemUser ? `${params.systemUser}:${params.systemUser}` : 'www-data:www-data';
      log(`[install] Setting permissions (owner: ${owner})...`);
      await this.executor.execute('chown', ['-R', owner, params.rootPath]);
      await this.executor.execute('chmod', ['-R', '750', wwwDir]);

      for (const subdir of ['core/cache', 'core/export', 'core/packages', 'assets']) {
        const dir = path.join(wwwDir, subdir);
        try {
          await fs.access(dir);
          await this.executor.execute('chmod', ['-R', '775', dir]);
        } catch {
          // will be created by setup
        }
      }

      // Step 4: MODX CLI setup. Для MODX 3 сначала пробуем cli-install.php,
      // потом setup/index.php. Для MODX Revo — только setup/index.php.
      // Если ВСЕ методы упали — это ОШИБКА установки: сайт не должен числиться
      // как RUNNING с пустой БД. Раньше тут писался config.inc.php вручную и
      // success возвращался — теперь честно падаем.
      let setupFailed: string | null = null;
      if (params.dbName) {
        if (label === '3') {
          log('[install] Running MODX 3 cli-install.php...');
          const cliRes = await this.runModx3CliInstall(wwwDir, params, log);
          if (!cliRes.success) {
            log(`[install] cli-install.php failed: ${cliRes.error}`);
            log('[install] Fallback → setup/index.php (config.xml mode)');
            const setupResult = await this.runModxSetup(wwwDir, params, log);
            if (!setupResult.success) {
              log(`[install] Setup failed: ${setupResult.error}`);
              await this.writeModxConfig(wwwDir, params);
              setupFailed = `cli-install: ${cliRes.error}; setup/index.php: ${setupResult.error}`;
            }
          }
        } else {
          log('[install] Running MODX Revo setup...');
          const setupResult = await this.runModxSetup(wwwDir, params, log);
          if (!setupResult.success) {
            log(`[install] CLI setup failed: ${setupResult.error}`);
            await this.writeModxConfig(wwwDir, params);
            setupFailed = setupResult.error || 'unknown setup error';
          }
        }
      } else {
        log('[install] No database configured, skipping setup');
      }

      if (setupFailed) {
        // Финальные пермишены и cleanup всё равно делаем (иначе setup/ юзера
        // в браузере не сможет писать в core/cache).
        await this.finalizeModxPermissions(params.rootPath, wwwDir, params.systemUser, log);
        if (params.systemUser) {
          const userTmp = path.join(params.rootPath, 'tmp');
          await this.executor.execute('mkdir', ['-p', userTmp]);
          await this.executor.execute('chown', [owner, userTmp]);
          await this.executor.execute('chmod', ['750', userTmp]);
        }
        return {
          success: false,
          error: `MODX setup упал: ${setupFailed}. Файлы установлены, БД не наполнена. Завершите установку через /setup/ в браузере или удалите сайт.`,
        };
      }

      // Финальная нормализация: чистим владельца и режимы рекурсивно
      // (setup создавал кэш-подкаталоги от root).
      await this.finalizeModxPermissions(params.rootPath, wwwDir, params.systemUser, log);

      if (params.systemUser) {
        const tmpDir = path.join(params.rootPath, 'tmp');
        await this.executor.execute('mkdir', ['-p', tmpDir]);
        await this.executor.execute('chown', [owner, tmpDir]);
        await this.executor.execute('chmod', ['750', tmpDir]);
      }

      // Финальная зачистка dev-мусора. setup/ оставляем, только если CLI-setup
      // провалился (писали config вручную) — чтобы юзер мог достроить в браузере.
      // Для успешного MODX Revo setup — вычищаем и setup/.
      await this.cleanupModxDevFiles(wwwDir, () => { /* тихо */ }, true);

      log(`[install] MODX ${label} ${version} installation complete`);
      return { success: true, version };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Перегенерирует composer autoload + platform_check.php под указанную PHP-версию.
   * Вызывается при смене phpVersion у сайта: если MODX3 (или любой composer-based сайт)
   * установили под 8.2, а потом переключили на 8.1 — vendor/composer/platform_check.php
   * всё ещё требует >= 8.2.0 и фатально падает при каждом запросе.
   *
   * Запускает `php{newVer} composer dump-autoload --no-dev` в wwwDir, который
   * регенерирует platform_check под новый PHP. Если vendor несовместим с новой
   * версией на уровне пакетов (нашей регенерацией это не исправить) — пробуем
   * `composer install --no-dev` как тяжёлый fallback; если и он фейлится —
   * платформа реально требует более новый PHP, и даунгрейд невозможен без обновления пакетов.
   */
  async regenerateComposerAutoload(
    rootPath: string,
    filesRelPath: string | undefined,
    newPhpVersion: string,
    onLog?: LogFn,
  ): Promise<InstallResult> {
    const log = onLog || (() => {});
    const wwwDir = this.resolveWwwDir(rootPath, filesRelPath);
    const composerJson = path.join(wwwDir, 'composer.json');

    try {
      await fs.access(composerJson);
    } catch {
      // сайт без composer — ничего делать не надо
      return { success: true };
    }

    const phpBin = `php${newPhpVersion}`;
    const composerPath = await this.resolveComposerPath();
    if (!composerPath) {
      log('[php-change] composer не найден — пропускаю регенерацию platform_check');
      return { success: true }; // non-fatal
    }

    // Проверяем, что такой php-бинарь вообще существует.
    const probe = await this.executor.execute(phpBin, ['-v'], { allowFailure: true });
    if (probe.exitCode !== 0) {
      return { success: false, error: `${phpBin} не установлен` };
    }

    log(`[php-change] Регенерирую vendor/composer/autoload под ${phpBin}...`);
    const dump = await this.executor.executeStreaming(
      phpBin,
      [composerPath, 'dump-autoload', '--no-dev', '--no-interaction', '--optimize'],
      {
        cwd: wwwDir,
        timeout: 180_000,
        allowFailure: true,
        onLine: (line, stream) => {
          const prefix = stream === 'stderr' ? '[composer!] ' : '[composer] ';
          log(prefix + line);
        },
      },
    );

    if (dump.exitCode !== 0) {
      return {
        success: false,
        error: dump.stderr.substring(0, 500) || `composer dump-autoload exit ${dump.exitCode}`,
      };
    }

    // Сознательно НЕ запускаем `composer update` с даунгрейдом зависимостей:
    // если пользователь понизил PHP до версии, которую не поддерживают установленные
    // пакеты — это его ответственность, и ему должна быть видна ошибка на сайте
    // (500 от platform_check.php), чтобы он принял решение явно.
    // Наша задача — только перегенерировать platform_check под новый PHP-бинарь,
    // что dump-autoload и делает.
    log(`[php-change] ✓ Autoload регенерирован под ${phpBin}`);
    return { success: true };
  }

  /**
   * Находит путь до composer на сервере. Нужен, чтобы вызвать его через
   * конкретный php-бинарь (`php8.X /usr/local/bin/composer ...`) — иначе
   * composer под своим shebang выбирает системный `php`, и vendor'ный
   * platform_check фиксируется под ту версию PHP, а не под ту, на которой
   * фактически будет работать сайт.
   */
  private composerPathCache: string | null | undefined = undefined;
  private async resolveComposerPath(): Promise<string | null> {
    if (this.composerPathCache !== undefined) return this.composerPathCache;
    // Порядок кандидатов и список — в agent/config.ts (env COMPOSER_PATHS).
    for (const p of COMPOSER_CANDIDATES) {
      try {
        await fs.access(p);
        this.composerPathCache = p;
        return p;
      } catch { /* next */ }
    }
    // fallback: которое `which composer` вернёт
    const which = await this.executor.execute('which', ['composer'], { allowFailure: true });
    if (which.exitCode === 0) {
      const p = which.stdout.trim();
      if (p) {
        this.composerPathCache = p;
        return p;
      }
    }
    this.composerPathCache = null;
    return null;
  }

  /**
   * Удаляет dev-мусор из корня MODX (build-тулы, GitHub-конфиги, package-lock
   * и т.п.) — всё, что в продакшене не нужно и путает пользователя при SFTP.
   * Ошибки тихо игнорируются: если чего-то нет — это нормально.
   *
   * Второй аргумент — `includeSetup`: если true, также удаляем директорию
   * `setup/`. cli-install.php по флагу --remove-setup-directory должен сам
   * её снести, но если инсталлер упал в fallback или апгрейд-скрипт не
   * довёл до конца — setup/ остаётся болтаться с публичным доступом.
   * Вычищаем принудительно уже после установки/апгрейда.
   */
  private async cleanupModxDevFiles(
    wwwDir: string,
    log: LogFn,
    includeSetup = true,
  ): Promise<void> {
    const junk = [
      '_build',
      '.github',
      '.gitignore',
      '.eslintrc.js',
      '.editorconfig',
      'codecov.yml',
      'crowdin.yml',
      'phpcs.xml',
      'package.json',
      'package-lock.json',
      'CODE_OF_CONDUCT.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'README.md',
      'COPYRIGHT',
      'LICENSE',
    ];
    if (includeSetup) junk.push('setup');

    const removed: string[] = [];
    const failed: Array<{ name: string; err: string }> = [];

    for (const name of junk) {
      const full = path.join(wwwDir, name);
      try {
        await fs.access(full);
      } catch {
        continue;
      }

      // fs.rm(recursive, force) — работает и для файлов, и для директорий,
      // и для вложенных файлов, которые принадлежат root:root (setup создаёт
      // подпапку .locked от root — раньше наш rm через CommandExecutor падал
      // на exit != 0 тихо и setup/ оставался публично доступным).
      try {
        await fs.rm(full, { recursive: true, force: true });
        removed.push(name);
      } catch (err) {
        const msg = (err as NodeJS.ErrnoException).code || (err as Error).message;
        // Fallback: если Node fs.rm обломался (ACL, immutable bit, что-то ещё) —
        // пробуем через `rm -rf`. Логируем оба результата.
        const res = await this.executor.execute('rm', ['-rf', full], { allowFailure: true });
        if (res.exitCode === 0) {
          removed.push(`${name} (rm fallback)`);
        } else {
          failed.push({
            name,
            err: `fs.rm: ${msg}; rm -rf: ${res.stderr.substring(0, 200) || `exit ${res.exitCode}`}`,
          });
        }
      }
    }

    if (removed.length) {
      log(`[install] Cleaned dev files: ${removed.join(', ')}`);
    }
    if (failed.length) {
      for (const f of failed) {
        log(`[install!] Не удалось удалить ${f.name}: ${f.err}`);
      }
    }
  }

  /** Определяет путь до web-root из rootPath + filesRelPath. */
  private resolveWwwDir(rootPath: string, filesRelPath?: string): string {
    const rel = (filesRelPath || 'www').replace(/^\/+/, '').replace(/\.\.+/g, '').replace(/\/+$/, '');
    return path.join(rootPath, rel || 'www');
  }

  /**
   * Финальная нормализация прав после install/upgrade MODX.
   *
   * Зачем: агент работает от root, поэтому `composer create-project`,
   * `setup/cli-install.php` и `setup/index.php --installmode=upgrade`
   * исполняются под root. PHP при первом обращении к кэшу создаёт подкаталоги
   * (`core/cache/auto_publish/`, `context_settings/`, `system_settings/` и т.п.)
   * с владельцем root:root и режимом 0755 — без group-write для systemUser.
   *
   * После этого PHP-FPM (под per-site юзером) **не может** перезаписать эти
   * файлы. Самое больное последствие: cached `eventMap` остаётся пустым
   * навсегда, и плагины MODX не срабатывают ни на одном событии.
   *
   * Решение: после любого install/upgrade чистим всё дерево сайта от
   * чужих владельцев (chown -R) + симметричный chmod -R с символическим
   * флагом `X` (exec только для директорий и уже-исполняемых файлов —
   * сохраняет +x на бинарниках, не делает обычные файлы исполняемыми).
   *
   * На writable-каталогах (cache/export/packages/assets) дополнительно
   * даём group-write — на случай, если PHP-FPM работает не под тем же
   * юзером, что владелец сайта (для www-data из системной группы).
   */
  private async finalizeModxPermissions(
    rootPath: string,
    wwwDir: string,
    systemUser: string | undefined,
    log: LogFn,
  ): Promise<void> {
    const owner = systemUser ? `${systemUser}:${systemUser}` : 'www-data:www-data';

    // 1. Владелец на всё дерево сайта (rootPath, не wwwDir — иначе tmp/logs
    //    останутся за прежним владельцем, если они вдруг root-owned).
    await this.executor.execute('chown', ['-R', owner, rootPath]);

    // 2. Базовые права. `X` (большая) = exec только для каталогов и
    //    уже-исполняемых файлов. Никаких +x на регулярных .php/.json/.css.
    //    u=rwX,g=rX,o-rwx → dirs/exec=0750, обычные файлы=0640.
    await this.executor.execute('chmod', ['-R', 'u=rwX,g=rX,o-rwx', wwwDir]);

    // 3. Writable-каталоги MODX — добавляем group-write.
    //    Это нужно, если PHP-FPM работает под другим юзером (www-data),
    //    добавленным в группу systemUser. Под per-site юзером (наш дефолт)
    //    группа всё равно своя — мешать не будет.
    for (const subdir of ['core/cache', 'core/export', 'core/packages', 'assets']) {
      const dir = path.join(wwwDir, subdir);
      try {
        await fs.access(dir);
        await this.executor.execute('chmod', ['-R', 'u=rwX,g=rwX,o-rwx', dir]);
      } catch {
        // не существует — пропускаем (возможно, не MODX)
      }
    }

    log('[install] Final permissions applied (owner + chmod recursively)');
  }

  /**
   * Переименовывает manager/connectors в каталоге с распакованным архивом MODX
   * (до наката на wwwDir). Используется в updateModxRevo: новые файлы должны
   * попасть в кастомные папки сайта (pkgs/ и т.п.), а не создать дефолтные
   * manager/ + connectors/ в корне рядом.
   *
   * Ломаться не имеем права — это апгрейд; при ошибке возвращаемся к дефолту
   * (логируем, но продолжаем), пользователь хотя бы увидит файлы.
   */
  private async renameSrcCustomPaths(
    srcDir: string,
    managerPath: string | undefined,
    connectorsPath: string | undefined,
    log: LogFn,
  ): Promise<void> {
    const mgr = (managerPath || 'manager').replace(/^\/+|\/+$/g, '');
    const cnn = (connectorsPath || 'connectors').replace(/^\/+|\/+$/g, '');

    if (mgr && mgr !== 'manager') {
      const src = path.join(srcDir, 'manager');
      const dst = path.join(srcDir, mgr);
      try {
        await fs.access(src);
        await this.executor.execute('rm', ['-rf', dst]);
        const r = await this.executor.execute('mv', [src, dst], { allowFailure: true });
        if (r.exitCode === 0) log(`[update] srcDir: renamed manager/ → ${mgr}/`);
        else log(`[update!] mv srcDir manager→${mgr} failed: ${r.stderr.substring(0, 200)}`);
      } catch { /* в архиве нет manager/ — ничего не делаем */ }
    }
    if (cnn && cnn !== 'connectors') {
      const src = path.join(srcDir, 'connectors');
      const dst = path.join(srcDir, cnn);
      try {
        await fs.access(src);
        await this.executor.execute('rm', ['-rf', dst]);
        const r = await this.executor.execute('mv', [src, dst], { allowFailure: true });
        if (r.exitCode === 0) log(`[update] srcDir: renamed connectors/ → ${cnn}/`);
        else log(`[update!] mv srcDir connectors→${cnn} failed: ${r.stderr.substring(0, 200)}`);
      } catch { /* ignore */ }
    }
  }

  /**
   * После composer require (MODX 3) — если у сайта кастомные пути manager/connectors,
   * новые файлы composer'а ложатся в дефолтные wwwDir/manager и wwwDir/connectors.
   * Надо наложить их поверх кастомных папок и удалить дефолтные.
   *
   * Используем `cp -rT src dst`: он перезаписывает файлы внутри dst, не меняя
   * те, которых нет в src (т.е. пользовательские плагины/темы в кастомной папке
   * не должны пострадать, если они были в unchanged поддиректориях — но вообще
   * в manager/ лежит только ядро MODX, юзеру там класть нечего).
   */
  private async mergeCustomPathsAfterOverlay(
    wwwDir: string,
    managerPath: string | undefined,
    connectorsPath: string | undefined,
    log: LogFn,
  ): Promise<void> {
    const mgr = (managerPath || 'manager').replace(/^\/+|\/+$/g, '');
    const cnn = (connectorsPath || 'connectors').replace(/^\/+|\/+$/g, '');

    if (mgr && mgr !== 'manager') {
      const defaultDir = path.join(wwwDir, 'manager');
      const customDir = path.join(wwwDir, mgr);
      try {
        await fs.access(defaultDir);
        // Кастомную директорию гарантируем (на случай первого апгрейда после миграции).
        await this.executor.execute('mkdir', ['-p', customDir]);
        const cp = await this.executor.execute('cp', ['-rT', defaultDir, customDir], { allowFailure: true });
        if (cp.exitCode !== 0) {
          log(`[update!] cp manager→${mgr} failed: ${cp.stderr.substring(0, 200)}`);
          return;
        }
        await this.executor.execute('rm', ['-rf', defaultDir]);
        log(`[update] merged default manager/ → ${mgr}/ (default removed)`);
      } catch { /* дефолтной manager/ нет — composer её не создал, всё ок */ }
    }
    if (cnn && cnn !== 'connectors') {
      const defaultDir = path.join(wwwDir, 'connectors');
      const customDir = path.join(wwwDir, cnn);
      try {
        await fs.access(defaultDir);
        await this.executor.execute('mkdir', ['-p', customDir]);
        const cp = await this.executor.execute('cp', ['-rT', defaultDir, customDir], { allowFailure: true });
        if (cp.exitCode !== 0) {
          log(`[update!] cp connectors→${cnn} failed: ${cp.stderr.substring(0, 200)}`);
          return;
        }
        await this.executor.execute('rm', ['-rf', defaultDir]);
        log(`[update] merged default connectors/ → ${cnn}/ (default removed)`);
      } catch { /* ignore */ }
    }
  }

  /** Переименовывает manager/connectors если заданы кастомные пути. */
  private async renameCustomPaths(
    wwwDir: string,
    params: ModxInstallParams,
    log: LogFn,
  ): Promise<void> {
    const mgrPath = params.managerPath || 'manager';
    const cnnPath = params.connectorsPath || 'connectors';

    if (mgrPath !== 'manager') {
      await this.executor.execute('mv', [
        path.join(wwwDir, 'manager'),
        path.join(wwwDir, mgrPath),
      ]);
      log(`[install] Renamed manager/ → ${mgrPath}/`);
    }
    if (cnnPath !== 'connectors') {
      await this.executor.execute('mv', [
        path.join(wwwDir, 'connectors'),
        path.join(wwwDir, cnnPath),
      ]);
      log(`[install] Renamed connectors/ → ${cnnPath}/`);
    }
  }

  /**
   * MODX 3 cli-install.php — CLI-установщик, читает плоские --key=value аргументы.
   *
   * ВАЖНО — все ключи пишутся с ПОДЧЁРКИВАНИЯМИ, НЕ с дефисами:
   *   --database_server, --core_path, --context_mgr_path, --http_host, ...
   *
   * Внутри скрипт (setup/cli-install.php) делает:
   *   $k = ltrim($tmp[0], '-');
   *   if (isset($variables[$k])) { $cli_variables[$k] = $tmp[1]; }
   * где в $variables все ключи — с "_". Если прокинуть `--core-path=...` через дефис,
   * он проваливается, `core_path` остаётся prompt-массивом → readline() уходит
   * в бесконечный цикл `while(!$res = readline(...))` и висит на stdin насмерть.
   *
   * Плюс `database_server` = ХОСТ БД (localhost/127.0.0.1), а движок указывается
   * через `database_type` (mysql/pgsql). Раньше мы туда писали 'mariadb' — тоже баг.
   *
   * Формат команды (правильный):
   *   php setup/cli-install.php \
   *     --database_type=mysql --database_server=127.0.0.1 \
   *     --database=NAME --database_user=USER --database_password=PASS \
   *     --table_prefix=modx_ --language=en \
   *     --cmsadmin=ADMIN --cmspassword=PASS --cmsadminemail=EMAIL \
   *     --core_path=ABS/core/ \
   *     --context_mgr_path=ABS/manager/ --context_mgr_url=/manager/ \
   *     --context_connectors_path=ABS/connectors/ --context_connectors_url=/connectors/ \
   *     --context_web_path=ABS/ --context_web_url=/ \
   *     --http_host=domain --https_port=443 --remove_setup_directory=1
   */
  private async runModx3CliInstall(
    wwwDir: string,
    params: ModxInstallParams,
    log: LogFn,
  ): Promise<InstallResult> {
    const cliPath = path.join(wwwDir, 'setup', 'cli-install.php');
    try {
      await fs.access(cliPath);
    } catch {
      return { success: false, error: 'setup/cli-install.php не найден — MODX3 не распакован' };
    }

    // Снести существующий setup/config.xml — иначе cli-install.php на старте
    // спрашивает интерактивно "load old values? (Y)" и висит в readline.
    const oldConfigXml = path.join(wwwDir, 'setup', 'config.xml');
    try {
      await fs.unlink(oldConfigXml);
      log('[install] Removed stale setup/config.xml from previous run');
    } catch { /* файла может не быть — ок */ }

    const isPg = params.dbType === 'POSTGRESQL';
    // MODX'овский movie-переключатель: database_type = 'mysql' | 'pgsql'.
    // MySQL и MariaDB отдаём как 'mysql' (xPDO по факту один драйвер PDO_MySQL).
    const dbType = isPg ? 'pgsql' : 'mysql';
    const dbHost = MODX_DB_DEFAULTS.HOST;
    const adminUser = params.adminUser || MODX_DB_DEFAULTS.DEFAULT_ADMIN_USERNAME;
    const adminPassword = params.adminPassword || crypto.randomBytes(12).toString('base64url');
    const adminEmail = params.adminEmail || `admin@${params.domain}`;
    const mgr = params.managerPath || 'manager';
    const cnn = params.connectorsPath || 'connectors';

    // Пароли иногда содержат '=' (base64 паддинг). cli-install.php режет arg
    // через `explode('=', $arg)` и, если count > 2, игнорирует весь аргумент →
    // database_password остаётся prompt → зависание.
    if (params.dbPassword.includes('=')) {
      return {
        success: false,
        error: 'DB password contains "=" — cli-install.php не умеет такие (регенерируйте пароль)',
      };
    }

    const phpBin = `php${params.phpVersion || DEFAULT_PHP_VERSION}`;
    // CLI-PHP тюнинг:
    //  - OPcache для CLI — ускоряет сам runtime на include'ах xPDO/modX
    //  - memory_limit=512M — resolver'ы транспорт-пакетов держат много в памяти
    //  - realpath_cache — меньше stat()ов на повторных include'ах
    //  - xdebug.mode=off — если включён глобально, может вешать процесс
    // JIT не включаем: на некоторых PHP 8.x + PDO замечены зависания.
    const phpFlags = [
      '-d', 'opcache.enable_cli=1',
      '-d', 'opcache.validate_timestamps=0',
      '-d', 'memory_limit=512M',
      '-d', 'realpath_cache_size=4096K',
      '-d', 'realpath_cache_ttl=600',
      '-d', 'xdebug.mode=off',
    ];
    const args = [
      ...phpFlags,
      cliPath,
      `--database_type=${dbType}`,
      `--database_server=${dbHost}`,
      `--database=${params.dbName}`,
      `--database_user=${params.dbUser}`,
      `--database_password=${params.dbPassword}`,
      `--database_connection_charset=${MODX_DB_DEFAULTS.MYSQL_CHARSET}`,
      `--database_charset=${MODX_DB_DEFAULTS.MYSQL_CHARSET}`,
      `--database_collation=${isPg ? MODX_DB_DEFAULTS.POSTGRESQL_COLLATION : MODX_DB_DEFAULTS.MYSQL_COLLATION}`,
      `--table_prefix=${MODX_DB_DEFAULTS.TABLE_PREFIX}`,
      '--language=en',
      `--cmsadmin=${adminUser}`,
      `--cmspassword=${adminPassword}`,
      `--cmsadminemail=${adminEmail}`,
      `--core_path=${wwwDir}/core/`,
      `--context_mgr_path=${wwwDir}/${mgr}/`,
      `--context_mgr_url=/${mgr}/`,
      `--context_connectors_path=${wwwDir}/${cnn}/`,
      `--context_connectors_url=/${cnn}/`,
      `--context_web_path=${wwwDir}/`,
      `--context_web_url=/`,
      `--http_host=${params.domain}`,
      `--https_port=${MODX_DB_DEFAULTS.HTTPS_PORT}`,
      '--remove_setup_directory=1',
    ];

    // Streaming + stdin=ignore: если cli-install.php всё равно решит спросить
    // (новая версия, новый ключ) — он получит EOF вместо зависания.
    const result = await this.executor.executeStreaming(phpBin, args, {
      cwd: wwwDir,
      timeout: 900_000, // 15 минут — с запасом на слабые VPS
      stdin: 'ignore',
      allowFailure: true,
      onLine: (line, stream) => {
        const prefix = stream === 'stderr' ? '[setup!] ' : '[setup] ';
        log(prefix + line);
      },
    });

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr.substring(0, 500) || `cli-install.php exit ${result.exitCode}` };
    }

    // ВАЖНО: пароль НЕ логируем — логи видны в UI и могут утечь в архивы.
    // Админ получает пароль отдельным каналом (API-ответ create-site).
    log(`[install] MODX 3 admin: ${adminUser} / [password set, see create-site response]`);
    log(`[install] MODX manager URL: https://${params.domain}/${mgr}/`);
    return { success: true };
  }

  /**
   * Запускает MODX setup в upgrade-режиме (apply схемы + патчи) — используется
   * и для Revo, и для MODX 3 после накатывания файлов новой версии.
   */
  private async runModxUpgrade(
    wwwDir: string,
    params: ModxUpdateParams,
    log: LogFn,
  ): Promise<InstallResult> {
    const setupDir = path.join(wwwDir, 'setup');
    try {
      await fs.access(setupDir);
    } catch {
      return { success: false, error: 'setup/ directory not found' };
    }

    const phpBin = `php${params.phpVersion || DEFAULT_PHP_VERSION}`;
    const result = await this.executor.executeStreaming(phpBin, [
      path.join(setupDir, 'index.php'),
      '--installmode=upgrade',
      `--core_path=${wwwDir}/core/`,
    ], {
      cwd: wwwDir,
      timeout: 300_000,
      allowFailure: true,
      onLine: (line, stream) => {
        const prefix = stream === 'stderr' ? '[setup!] ' : '[setup] ';
        log(prefix + line);
      },
    });

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr.substring(0, 500) || `setup exited ${result.exitCode}` };
    }
    return { success: true };
  }

  /**
   * Run MODX CLI setup — generates config.xml and executes setup/index.php.
   * Это legacy-путь для MODX Revo 2.x (и fallback для 3).
   */
  private async runModxSetup(
    wwwDir: string,
    params: ModxInstallParams,
    log: LogFn,
  ): Promise<InstallResult> {
    const setupDir = path.join(wwwDir, 'setup');

    try {
      await fs.access(setupDir);
    } catch {
      return { success: false, error: 'setup/ directory not found' };
    }

    const isPg = params.dbType === 'POSTGRESQL';
    const adminUser = params.adminUser || MODX_DB_DEFAULTS.DEFAULT_ADMIN_USERNAME;
    const adminPassword = params.adminPassword || crypto.randomBytes(12).toString('base64url');
    const adminEmail = params.adminEmail || `admin@${params.domain}`;

    const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<modx>
    <database_type>${isPg ? 'pgsql' : 'mysql'}</database_type>
    <database_server>${MODX_DB_DEFAULTS.HOST}</database_server>
    <database>${params.dbName}</database>
    <database_user>${params.dbUser}</database_user>
    <database_password>${this.escapeXml(params.dbPassword)}</database_password>
    <database_connection_charset>${MODX_DB_DEFAULTS.MYSQL_CHARSET}</database_connection_charset>
    <database_charset>${MODX_DB_DEFAULTS.MYSQL_CHARSET}</database_charset>
    <database_collation>${isPg ? MODX_DB_DEFAULTS.POSTGRESQL_COLLATION : MODX_DB_DEFAULTS.MYSQL_COLLATION}</database_collation>
    <table_prefix>${MODX_DB_DEFAULTS.TABLE_PREFIX}</table_prefix>
    <https_port>${MODX_DB_DEFAULTS.HTTPS_PORT}</https_port>
    <http_host>${params.domain}</http_host>
    <inplace>1</inplace>
    <unpacked>0</unpacked>
    <language>ru</language>
    <cmsadmin>${adminUser}</cmsadmin>
    <cmspassword>${this.escapeXml(adminPassword)}</cmspassword>
    <cmsadminemail>${adminEmail}</cmsadminemail>
    <core_path>${wwwDir}/core/</core_path>
    <context_mgr_path>${wwwDir}/${params.managerPath || 'manager'}/</context_mgr_path>
    <context_mgr_url>/${params.managerPath || 'manager'}/</context_mgr_url>
    <context_connectors_path>${wwwDir}/${params.connectorsPath || 'connectors'}/</context_connectors_path>
    <context_connectors_url>/${params.connectorsPath || 'connectors'}/</context_connectors_url>
    <context_web_path>${wwwDir}/</context_web_path>
    <context_web_url>/</context_web_url>
    <remove_setup_directory>1</remove_setup_directory>
</modx>
`;

    const configPath = path.join(setupDir, 'config.xml');
    await fs.writeFile(configPath, configXml, 'utf-8');

    const phpBin = `php${params.phpVersion || DEFAULT_PHP_VERSION}`;

    log('[install] Running MODX database setup (this may take a minute)...');
    const result = await this.executor.executeStreaming(phpBin, [
      path.join(setupDir, 'index.php'),
      '--installmode=new',
      `--core_path=${wwwDir}/core/`,
      `--config=${configPath}`,
    ], {
      cwd: wwwDir,
      timeout: 300_000,
      allowFailure: true,
      onLine: (line, stream) => {
        const prefix = stream === 'stderr' ? '[setup!] ' : '[setup] ';
        log(prefix + line);
      },
    });

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr.substring(0, 500) || 'Setup exited with non-zero code' };
    }

    // Пароль не в логи (см. install MODX 3 выше).
    log(`[install] MODX admin: ${adminUser} / [password set, see create-site response]`);
    log(`[install] MODX manager URL: https://${params.domain}/${params.managerPath || 'manager'}/`);

    return { success: true };
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Extract a ZIP file. Tries `unzip` first, falls back to Node.js built-in.
   */
  private async extractZip(
    zipPath: string,
    destDir: string,
    log: LogFn,
  ): Promise<boolean> {
    const unzipResult = await this.executor.execute('unzip', [
      '-o', '-q',
      zipPath,
      '-d', destDir,
    ], { timeout: 60_000, allowFailure: true });

    if (unzipResult.exitCode === 0) {
      return true;
    }

    log('[install] unzip not available, using Node.js extractor...');
    try {
      const extractScript = path.join(destDir, '_extract.mjs');
      // Защита от zip-slip (CVE-2018-1002200 family):
      //   1) Отбрасываем записи с `..` в имени после normalize.
      //   2) Проверяем, что resolved путь лежит внутри destDir.
      //   3) Пропускаем абсолютные пути, NUL-байты, backslash-имена.
      // Без этих проверок злонамеренный ZIP мог писать файлы за пределами
      // destDir (напр., в /etc/cron.d) при запуске агента под root.
      const scriptContent = `
import { mkdir, writeFile } from 'fs/promises';
import { resolve, join, dirname, sep, normalize } from 'path';
import { Buffer } from 'buffer';

const zipPath = process.argv[2];
const destDir = resolve(process.argv[3]);
const destPrefix = destDir.endsWith(sep) ? destDir : destDir + sep;

function isSafeEntryName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('\\u0000')) return false;
  if (name.includes('\\\\')) return false; // forbid backslashes in zip entries
  if (name.startsWith('/')) return false;
  const norm = normalize(name);
  if (norm.startsWith('..' + sep) || norm === '..' || norm.includes(sep + '..' + sep)) {
    return false;
  }
  return true;
}

function resolveSafePath(name) {
  const target = resolve(destDir, name);
  if (target !== destDir && !target.startsWith(destPrefix)) return null;
  return target;
}

const buf = await import('fs').then(fs => fs.promises.readFile(zipPath));
let offset = 0;
let count = 0;
let skipped = 0;

while (offset < buf.length - 4) {
  if (buf.readUInt32LE(offset) !== 0x04034b50) break;

  const compMethod = buf.readUInt16LE(offset + 8);
  const compSize = buf.readUInt32LE(offset + 18);
  const uncompSize = buf.readUInt32LE(offset + 22);
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
  const dataStart = offset + 30 + nameLen + extraLen;

  if (!isSafeEntryName(name)) {
    skipped++;
    offset = dataStart + compSize;
    continue;
  }

  const filePath = resolveSafePath(name);
  if (!filePath) {
    skipped++;
    offset = dataStart + compSize;
    continue;
  }

  if (name.endsWith('/')) {
    await mkdir(filePath, { recursive: true });
  } else {
    const parent = dirname(filePath);
    if (parent !== destDir && !parent.startsWith(destPrefix)) {
      skipped++;
      offset = dataStart + compSize;
      continue;
    }
    await mkdir(parent, { recursive: true });
    if (compMethod === 0) {
      await writeFile(filePath, buf.subarray(dataStart, dataStart + compSize));
    } else if (compMethod === 8) {
      const { inflateRawSync } = await import('zlib');
      const data = inflateRawSync(buf.subarray(dataStart, dataStart + compSize));
      await writeFile(filePath, data);
    }
    count++;
  }

  offset = dataStart + compSize;
}

console.log(\`Extracted \${count} files (skipped unsafe: \${skipped})\`);
`;

      await fs.writeFile(extractScript, scriptContent, 'utf-8');
      const result = await this.executor.execute('node', [extractScript, zipPath, destDir], {
        timeout: 120_000,
        allowFailure: true,
      });
      await fs.unlink(extractScript).catch(() => {});

      if (result.exitCode === 0) {
        log(`[install] ${result.stdout.trim()}`);
        return true;
      }

      log(`[install] Node extractor failed: ${result.stderr}`);
      return false;
    } catch (err) {
      log(`[install] Extraction error: ${(err as Error).message}`);
      return false;
    }
  }

  private async createModxStub(
    wwwDir: string,
    params: ModxInstallParams,
  ): Promise<void> {
    for (const dir of [
      'core/cache', 'core/config', 'core/packages', 'core/model',
      'assets/components', 'assets/images',
      'manager', 'connectors',
    ]) {
      await this.executor.execute('mkdir', ['-p', path.join(wwwDir, dir)]);
    }

    const dbInfo = params.dbName
      ? `Database: ${params.dbName} / User: ${params.dbUser}`
      : 'No database configured yet';

    const indexPhp = `<?php
/**
 * Site: ${params.domain}
 * MODX files pending installation.
 */
echo '<h1>${params.domain}</h1>';
echo '<p>MODX not yet installed. Upload files or deploy from git.</p>';
echo '<p>${dbInfo}</p>';
`;
    await fs.writeFile(path.join(wwwDir, 'index.php'), indexPhp, 'utf-8');

    if (params.dbName) {
      await this.writeModxConfig(wwwDir, params);
    }

    const owner = params.systemUser ? `${params.systemUser}:${params.systemUser}` : 'www-data:www-data';
    await this.executor.execute('chown', ['-R', owner, path.dirname(wwwDir)]);
  }

  private async writeModxConfig(
    wwwDir: string,
    params: ModxInstallParams,
  ): Promise<void> {
    const configDir = path.join(wwwDir, 'core', 'config');
    await this.executor.execute('mkdir', ['-p', configDir]);

    const dbHost = MODX_DB_DEFAULTS.HOST;
    const isPg = params.dbType === 'POSTGRESQL';
    const dbPort = isPg ? MODX_DB_DEFAULTS.POSTGRESQL_PORT : MODX_DB_DEFAULTS.MYSQL_PORT;
    const dbDsn = isPg
      ? `pgsql:host=${dbHost};port=${dbPort};dbname=${params.dbName}`
      : `mysql:host=${dbHost};port=${dbPort};dbname=${params.dbName};charset=${MODX_DB_DEFAULTS.CHARSET}`;

    const siteId = `meowbox-${params.domain.replace(/[^a-zA-Z0-9]/g, '')}`;
    // SHA-256 вместо MD5 — MD5 криптографически сломан (collision attacks).
    // Сам sessionName не секрет, но MD5 поднимает флаги в security-аудитах,
    // а SHA-256 такой же длины не несёт никакого минуса.
    const sessionName = `SN${crypto.createHash('sha256').update(params.domain).digest('hex').substring(0, 8)}`;
    const uuid = crypto.randomUUID();

    // Escape для PHP single-quoted строк: только `'` и `\` нужно экранировать.
    // Если в пароле БД встретится `'` (а base64url его не даёт, но кто-то
    // мог вручную задать пароль) — без эскейпа PHP-конфиг сломается, в худшем
    // случае исполнит инжектированный PHP-код при include.
    const phpEsc = (v: string): string => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const dbUserEsc = phpEsc(params.dbUser);
    const dbPasswordEsc = phpEsc(params.dbPassword);
    const dbNameEsc = phpEsc(params.dbName);
    const dbDsnEsc = phpEsc(dbDsn);
    const dbHostEsc = phpEsc(dbHost);

    const config = `<?php
/**
 * MODX Configuration — auto-generated by Meowbox
 */
$database_type = '${isPg ? 'pgsql' : 'mysql'}';
$database_server = '${dbHostEsc}';
$database_user = '${dbUserEsc}';
$database_password = '${dbPasswordEsc}';
$database_connection_charset = '${MODX_DB_DEFAULTS.CHARSET}';
$dbase = '${dbNameEsc}';
$table_prefix = '${MODX_DB_DEFAULTS.TABLE_PREFIX}';
$database_dsn = '${dbDsnEsc}';
$config_options = array();
$driver_options = array();

$lastInstallTime = ${Math.floor(Date.now() / 1000)};

$site_id = '${siteId}';
$site_sessionname = '${sessionName}';
$https_port = '${MODX_DB_DEFAULTS.HTTPS_PORT}';
$uuid = '${uuid}';

if (!defined('MODX_CORE_PATH')) {
    $modx_core_path = '${wwwDir}/core/';
    $modx_processors_path = $modx_core_path . 'model/modx/processors/';
    $modx_connectors_path = '${wwwDir}/${params.connectorsPath || 'connectors'}/';
    $modx_connectors_url = '/${params.connectorsPath || 'connectors'}/';
    $modx_manager_path = '${wwwDir}/${params.managerPath || 'manager'}/';
    $modx_manager_url = '/${params.managerPath || 'manager'}/';
    $modx_base_path = '${wwwDir}/';
    $modx_base_url = '/';
    $modx_assets_path = '${wwwDir}/assets/';
    $modx_assets_url = '/assets/';
}
`;
    await fs.writeFile(
      path.join(configDir, 'config.inc.php'),
      config,
      'utf-8',
    );
  }

  // ===========================================================================
  // CUSTOM site scaffolding (пустой шаблон — {filesRelPath}/ + index.html)
  // ===========================================================================

  async scaffoldCustomSite(
    rootPath: string,
    domain: string,
    onLog?: LogFn,
    systemUser?: string,
    filesRelPath?: string,
  ): Promise<InstallResult> {
    const log = onLog || (() => {});

    try {
      const wwwDir = this.resolveWwwDir(rootPath, filesRelPath);
      await this.executor.execute('mkdir', ['-p', wwwDir]);

      const indexHtml = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${domain}</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0f; color: #fff; }
    .c { text-align: center; max-width: 560px; padding: 0 1.5rem; }
    h1 { font-size: 2rem; margin: 0 0 0.75rem; }
    p { color: rgba(255,255,255,0.6); line-height: 1.5; }
    code { background: rgba(255,255,255,0.1); padding: 0.2em 0.5em; border-radius: 4px; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="c">
    <h1>${domain}</h1>
    <p>Сайт создан. Загрузите файлы в <code>${(filesRelPath || 'www').replace(/\/+$/, '')}/</code> через SFTP или деплой из git.</p>
  </div>
</body>
</html>`;

      await fs.writeFile(
        path.join(wwwDir, 'index.html'),
        indexHtml,
        'utf-8',
      );

      const owner = systemUser ? `${systemUser}:${systemUser}` : 'www-data:www-data';
      await this.executor.execute('chown', ['-R', owner, rootPath]);
      await this.executor.execute('chmod', ['-R', '750', rootPath]);

      log(`[install] CUSTOM site scaffold created at ${wwwDir}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}
