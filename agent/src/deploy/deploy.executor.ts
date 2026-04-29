import { CommandExecutor } from '../command-executor';
import * as fs from 'fs';
import * as path from 'path';
import { COMPOSER_CANDIDATES, DEFAULT_PHP_VERSION } from '../config';

// Защита от arg-flag smuggling: git fetch/clone/checkout принимает любой аргумент
// начинающийся с `-` как флаг (`--upload-pack=...`, `-c core.sshCommand=...`).
// Branch и repo URL — пользовательский ввод; должны быть строго валидированы
// на агенте, даже если API уже валидирует, — defense in depth.
//
// Branch: общепринятые символы git refs (буквы/цифры/`._/-`), без leading `-`.
// Repo: HTTPS/SSH URL, либо file:// + локальный путь. Без `-` в начале и без
// shell-метасимволов — execFile уже не подвержен shell injection, но git
// сам интерпретирует `-` как флаг.
const GIT_BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/;
const GIT_REPO_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)[A-Za-z0-9._@:/+~?&=#%-]{1,2047}$/;

function assertGitBranch(branch: string): void {
  if (typeof branch !== 'string' || !GIT_BRANCH_RE.test(branch)) {
    throw new Error('Invalid git branch name');
  }
}

function assertGitRepo(repo: string): void {
  if (typeof repo !== 'string' || !GIT_REPO_RE.test(repo)) {
    throw new Error('Invalid git repository URL');
  }
}

function assertGitCommit(sha: string): void {
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    throw new Error('Invalid git commit SHA');
  }
}

interface DeployParams {
  siteType: string;
  rootPath: string;
  gitRepository: string;
  branch: string;
  phpVersion?: string;
  appPort?: number;
  domain: string;
  envVars?: Record<string, string>;
}

interface DeployResult {
  success: boolean;
  commitSha?: string;
  commitMessage?: string;
  output: string;
}

type LogFn = (line: string) => void;

/**
 * Executes deploy steps for a site.
 * Streams progress via a callback so the API can push real-time logs.
 */
export class DeployExecutor {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  async deploy(params: DeployParams, onLog: LogFn): Promise<DeployResult> {
    const output: string[] = [];
    const log = (line: string) => {
      output.push(line);
      onLog(line + '\n');
    };

    try {
      log(`[deploy] Starting deploy for ${params.domain}`);
      log(`[deploy] Type: ${params.siteType}, Branch: ${params.branch}`);

      // Step 1: Git — clone or pull
      await this.gitStep(params, log);

      // Step 2: Get commit info
      const commitInfo = await this.getCommitInfo(params.rootPath);
      log(`[deploy] Commit: ${commitInfo.sha?.substring(0, 8)} — ${commitInfo.message}`);

      // Step 3: Build based on site type
      await this.buildStep(params, log);

      // Step 4: Restart services
      await this.restartStep(params, log);

      log(`[deploy] Deploy completed successfully`);

      return {
        success: true,
        commitSha: commitInfo.sha,
        commitMessage: commitInfo.message,
        output: output.join('\n'),
      };
    } catch (err: unknown) {
      const message = (err as Error).message || 'Unknown error';
      log(`[deploy] FAILED: ${message}`);
      return {
        success: false,
        output: output.join('\n'),
      };
    }
  }

  async rollback(
    params: { rootPath: string; commitSha: string; siteType: string; domain: string; phpVersion?: string },
    onLog: LogFn,
  ): Promise<DeployResult> {
    const output: string[] = [];
    const log = (line: string) => {
      output.push(line);
      onLog(line + '\n');
    };

    try {
      log(`[rollback] Rolling back ${params.domain} to ${params.commitSha.substring(0, 8)}`);
      assertGitCommit(params.commitSha);

      // Git checkout to specified commit
      const checkout = await this.executor.execute(
        'git', ['checkout', '--', params.commitSha],
        { cwd: params.rootPath },
      );
      if (checkout.exitCode !== 0) {
        throw new Error(`Git checkout failed: ${checkout.stderr}`);
      }
      log('[rollback] Checked out target commit');

      // Rebuild
      const buildParams: DeployParams = {
        siteType: params.siteType,
        rootPath: params.rootPath,
        gitRepository: '',
        branch: '',
        domain: params.domain,
        phpVersion: params.phpVersion,
      };
      await this.buildStep(buildParams, log);

      // Restart services
      await this.restartStep(buildParams, log);

      const commitInfo = await this.getCommitInfo(params.rootPath);
      log('[rollback] Rollback completed successfully');

      return {
        success: true,
        commitSha: commitInfo.sha,
        commitMessage: commitInfo.message,
        output: output.join('\n'),
      };
    } catch (err) {
      const message = (err as Error).message || 'Unknown error';
      log(`[rollback] FAILED: ${message}`);
      return { success: false, output: output.join('\n') };
    }
  }

  private async gitStep(params: DeployParams, log: LogFn): Promise<void> {
    const { rootPath, gitRepository, branch } = params;
    assertGitBranch(branch);
    assertGitRepo(gitRepository);

    if (fs.existsSync(path.join(rootPath, '.git'))) {
      // Existing repo — fetch and reset to branch.
      // `--` отделяет options от refspec'а, чтобы git не принял branch
      // вида `--upload-pack=...` за флаг (даже если регексп его не пустит,
      // оставляем разделитель как defense-in-depth).
      log('[git] Fetching latest changes...');
      const fetch = await this.executor.execute('git', ['fetch', 'origin', '--', branch], {
        cwd: rootPath,
        timeout: 120_000,
      });
      if (fetch.exitCode !== 0) {
        throw new Error(`Git fetch failed: ${fetch.stderr}`);
      }

      log('[git] Checking out and resetting...');
      const checkout = await this.executor.execute(
        'git',
        ['checkout', '--', branch],
        { cwd: rootPath },
      );
      if (checkout.exitCode !== 0) {
        throw new Error(`Git checkout failed: ${checkout.stderr}`);
      }

      const reset = await this.executor.execute(
        'git',
        ['reset', '--hard', `origin/${branch}`],
        { cwd: rootPath },
      );
      if (reset.exitCode !== 0) {
        throw new Error(`Git reset failed: ${reset.stderr}`);
      }

      log('[git] Updated to latest commit');
    } else {
      // Fresh clone
      log('[git] Cloning repository...');

      // Ensure parent directory exists
      const parentDir = path.dirname(rootPath);
      if (!fs.existsSync(parentDir)) {
        await this.executor.execute('mkdir', ['-p', parentDir]);
      }

      // git clone не принимает `--` для repo+dest, но мы валидировали оба
      // через GIT_REPO_RE / абсолютный путь rootPath.
      const clone = await this.executor.execute(
        'git',
        ['clone', '--branch', branch, '--single-branch', '--depth', '1', '--', gitRepository, rootPath],
        { timeout: 300_000 }, // 5 min for large repos
      );
      if (clone.exitCode !== 0) {
        throw new Error(`Git clone failed: ${clone.stderr}`);
      }

      log('[git] Repository cloned');
    }
  }

  private async getCommitInfo(
    rootPath: string,
  ): Promise<{ sha?: string; message?: string }> {
    const shaResult = await this.executor.execute(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: rootPath },
    );
    const msgResult = await this.executor.execute(
      'git',
      ['log', '-1', '--format=%s'],
      { cwd: rootPath },
    );

    return {
      sha: shaResult.exitCode === 0 ? shaResult.stdout.trim() : undefined,
      message: msgResult.exitCode === 0 ? msgResult.stdout.trim() : undefined,
    };
  }

  private async buildStep(params: DeployParams, log: LogFn): Promise<void> {
    const { siteType, rootPath, phpVersion, envVars } = params;

    switch (siteType) {
      case 'MODX_REVO':
      case 'MODX_3':
        await this.buildPhp(rootPath, phpVersion, log);
        break;

      case 'NUXT_3':
      case 'REACT':
      case 'NESTJS':
        await this.buildNode(rootPath, envVars, log);
        break;

      case 'STATIC_HTML':
        // Check if there's a package.json (e.g., Vite static)
        if (fs.existsSync(path.join(rootPath, 'package.json'))) {
          await this.buildNode(rootPath, envVars, log);
        } else {
          log('[build] Static site — no build required');
        }
        break;

      case 'CUSTOM':
      default:
        log('[build] Custom type — skipping automated build');
        break;
    }
  }

  private async buildPhp(rootPath: string, phpVersion: string | undefined, log: LogFn): Promise<void> {
    // Check for composer.json
    if (!fs.existsSync(path.join(rootPath, 'composer.json'))) {
      log('[build] No composer.json found, skipping');
      return;
    }

    const phpBin = phpVersion ? `php${phpVersion}` : 'php';

    log('[build] Running composer install...');
    // Берём первый composer из списка кандидатов (env COMPOSER_PATHS).
    // Если никого не нашли — оставляем legacy-путь, чтобы ошибка с понятным
    // stderr выскочила в логе билда, а не падала в TypeError.
    const composerBin = COMPOSER_CANDIDATES[0] || '/usr/local/bin/composer';
    const result = await this.executor.execute(
      phpBin,
      [
        composerBin,
        'install',
        '--no-dev',
        '--optimize-autoloader',
        '--no-interaction',
      ],
      {
        cwd: rootPath,
        timeout: 300_000, // 5 min
      },
    );

    if (result.exitCode !== 0) {
      throw new Error(`Composer install failed: ${result.stderr}`);
    }
    if (result.stdout) log(result.stdout.trim());
    log('[build] Composer install complete');
  }

  private async buildNode(
    rootPath: string,
    envVars: Record<string, string> | undefined,
    log: LogFn,
  ): Promise<void> {
    if (!fs.existsSync(path.join(rootPath, 'package.json'))) {
      log('[build] No package.json found, skipping');
      return;
    }

    // Determine package manager
    const hasYarnLock = fs.existsSync(path.join(rootPath, 'yarn.lock'));
    const hasPnpmLock = fs.existsSync(path.join(rootPath, 'pnpm-lock.yaml'));

    let installCmd: string;
    let buildCmd: string;

    if (hasPnpmLock) {
      installCmd = 'pnpm';
      buildCmd = 'pnpm';
    } else if (hasYarnLock) {
      installCmd = 'yarn';
      buildCmd = 'yarn';
    } else {
      installCmd = 'npm';
      buildCmd = 'npm';
    }

    // Install dependencies
    log(`[build] Installing dependencies with ${installCmd}...`);
    const installArgs = installCmd === 'npm' ? ['ci', '--omit=dev'] : ['install', '--frozen-lockfile'];
    const install = await this.executor.execute(
      installCmd,
      installArgs,
      {
        cwd: rootPath,
        timeout: 300_000,
        env: envVars,
      },
    );

    if (install.exitCode !== 0) {
      throw new Error(`${installCmd} install failed: ${install.stderr}`);
    }
    log(`[build] Dependencies installed`);

    // Build
    log('[build] Running build...');
    const buildArgs = buildCmd === 'npm' ? ['run', 'build'] : ['build'];
    const build = await this.executor.execute(
      buildCmd,
      buildArgs,
      {
        cwd: rootPath,
        timeout: 600_000, // 10 min for builds
        env: envVars,
      },
    );

    if (build.exitCode !== 0) {
      throw new Error(`Build failed: ${build.stderr}`);
    }
    log('[build] Build complete');
  }

  private async restartStep(params: DeployParams, log: LogFn): Promise<void> {
    const { siteType, domain, phpVersion } = params;

    switch (siteType) {
      case 'MODX_REVO':
      case 'MODX_3': {
        // Restart PHP-FPM pool
        const version = phpVersion || DEFAULT_PHP_VERSION;
        log(`[restart] Reloading php${version}-fpm...`);
        const result = await this.executor.execute(
          'systemctl',
          ['reload', `php${version}-fpm`],
        );
        if (result.exitCode !== 0) {
          log(`[restart] Warning: PHP-FPM reload failed: ${result.stderr}`);
        }
        break;
      }

      case 'NUXT_3':
      case 'REACT':
      case 'NESTJS': {
        // Restart PM2 process
        const pmName = `site-${domain}`;
        log(`[restart] Restarting PM2 process ${pmName}...`);
        const result = await this.executor.execute('pm2', ['restart', pmName]);
        if (result.exitCode !== 0) {
          // Process might not exist yet — try to start it
          log('[restart] PM2 process not found, starting...');
          const startResult = await this.executor.execute('pm2', [
            'start',
            'npm',
            '--name',
            pmName,
            '--',
            'start',
          ], { cwd: params.rootPath });
          if (startResult.exitCode !== 0) {
            log(`[restart] Warning: PM2 start failed: ${startResult.stderr}`);
          }
        }
        break;
      }

      case 'STATIC_HTML':
      case 'CUSTOM':
      default:
        // Reload Nginx in case configs changed
        log('[restart] Reloading Nginx...');
        await this.executor.execute('systemctl', ['reload', 'nginx']);
        break;
    }

    log('[restart] Services restarted');
  }
}
