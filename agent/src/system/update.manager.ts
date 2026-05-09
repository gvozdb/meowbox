import { CommandExecutor } from '../command-executor';
import { MEOWBOX_BASE_DIR, SUPPORTED_PHP_VERSIONS } from '../config';

export interface UpdatablePackage {
  name: string;
  currentVersion: string;
  newVersion: string;
  section: string; // e.g., 'system', 'nginx', 'php', 'mariadb', 'nodejs'
}

export interface UpdateCheckResult {
  available: UpdatablePackage[];
  lastChecked: string;
}

export interface UpdateInstallResult {
  upgraded: string[];
  failed: string[];
  output: string;
}

/** Packages we care about — mapped to their logical section */
const SECTION_PATTERNS: Array<[RegExp, string]> = [
  [/^nginx/, 'nginx'],
  [/^php/, 'php'],
  [/^mariadb|^mysql/, 'mariadb'],
  [/^postgresql|^libpq/, 'postgresql'],
  [/^redis/, 'redis'],
  [/^certbot/, 'certbot'],
];

function classifyPackage(name: string): string {
  for (const [pattern, section] of SECTION_PATTERNS) {
    if (pattern.test(name)) return section;
  }
  return 'system';
}

export class UpdateManager {
  constructor(private readonly cmd: CommandExecutor) {}

  /**
   * Run `apt-get update` then `apt list --upgradable` to find available updates.
   */
  async check(): Promise<{ success: boolean; data?: UpdateCheckResult; error?: string }> {
    try {
      // Update package index
      const aptUpdate = await this.cmd.execute('apt-get', ['update', '-qq'], { timeout: 120_000, allowFailure: true });
      if (aptUpdate.exitCode !== 0 && !aptUpdate.stderr.includes('WARNING')) {
        return { success: false, error: `apt-get update failed: ${aptUpdate.stderr}` };
      }

      // List upgradable packages — apt-cache может вернуть >0 если кэш ещё не сформирован.
      const result = await this.cmd.execute('apt-cache', ['--generate', 'pkgnames'], { timeout: 30_000, allowFailure: true });

      // Use apt-get -s upgrade to simulate and get the list
      const simResult = await this.cmd.execute(
        'apt-get',
        ['--simulate', 'upgrade'],
        { timeout: 60_000, allowFailure: true },
      );

      const packages: UpdatablePackage[] = [];
      // Parse "Inst <package> [current] (new version ...)" lines
      for (const line of simResult.stdout.split('\n')) {
        const match = line.match(/^Inst\s+(\S+)\s+\[([^\]]+)\]\s+\((\S+)/);
        if (match) {
          packages.push({
            name: match[1],
            currentVersion: match[2],
            newVersion: match[3],
            section: classifyPackage(match[1]),
          });
        }
      }

      return {
        success: true,
        data: {
          available: packages,
          lastChecked: new Date().toISOString(),
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Install specific package updates.
   */
  async installPackages(packageNames: string[]): Promise<{ success: boolean; data?: UpdateInstallResult; error?: string }> {
    if (!packageNames.length) {
      return { success: false, error: 'No packages specified' };
    }

    // Validate package names to prevent injection (only allow alphanumeric, dash, dot, plus, colon)
    for (const name of packageNames) {
      if (!/^[a-zA-Z0-9_.+:-]+$/.test(name)) {
        return { success: false, error: `Invalid package name: ${name}` };
      }
    }

    try {
      const args = [
        '-y',
        '--only-upgrade',
        'install',
        ...packageNames,
      ];

      const result = await this.cmd.execute('apt-get', args, { timeout: 300_000, allowFailure: true });

      const upgraded: string[] = [];
      const failed: string[] = [];

      // Parse output for results
      for (const name of packageNames) {
        if (result.stdout.includes(`Setting up ${name}`) || result.stdout.includes(`Unpacking ${name}`)) {
          upgraded.push(name);
        } else if (result.exitCode !== 0) {
          failed.push(name);
        } else {
          upgraded.push(name); // Consider upgraded if no error
        }
      }

      return {
        success: true,
        data: {
          upgraded,
          failed,
          output: (result.stdout + '\n' + result.stderr).trim(),
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Upgrade all packages (apt-get upgrade -y).
   */
  async upgradeAll(): Promise<{ success: boolean; data?: UpdateInstallResult; error?: string }> {
    try {
      const result = await this.cmd.execute(
        'apt-get',
        ['-y', 'upgrade'],
        { timeout: 600_000, allowFailure: true },
      );

      const upgraded: string[] = [];
      for (const line of result.stdout.split('\n')) {
        const match = line.match(/^Setting up\s+(\S+)/);
        if (match) {
          upgraded.push(match[1]);
        }
      }

      return {
        success: true,
        data: {
          upgraded,
          failed: [],
          output: (result.stdout + '\n' + result.stderr).trim(),
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Self-update Meowbox: git pull, rebuild all packages, restart PM2.
   */
  async selfUpdate(): Promise<{ success: boolean; output?: string; error?: string }> {
    const meowboxDir = MEOWBOX_BASE_DIR;
    const output: string[] = [];
    const log = (line: string) => output.push(line);

    try {
      // Step 1: Git pull
      log('[update] Pulling latest changes...');
      const pull = await this.cmd.execute('git', ['pull', '--ff-only'], {
        cwd: meowboxDir,
        timeout: 60_000,
        allowFailure: true,
      });
      if (pull.exitCode !== 0) {
        return { success: false, error: `Git pull failed: ${pull.stderr}`, output: output.join('\n') };
      }
      log(pull.stdout.trim());

      // Step 2: Install dependencies for all packages
      log('[update] Installing dependencies...');
      const npmInstall = await this.cmd.execute('npm', ['install'], {
        cwd: meowboxDir,
        timeout: 300_000,
        allowFailure: true,
      });
      if (npmInstall.exitCode !== 0) {
        log(`[update] Warning: npm install: ${npmInstall.stderr}`);
      }

      // Step 3: Build shared
      log('[update] Building shared...');
      await this.cmd.execute('npx', ['tsc'], {
        cwd: `${meowboxDir}/shared`,
        timeout: 60_000,
      });

      // Step 4: Build API
      log('[update] Building API...');
      const apiBuild = await this.cmd.execute('npx', ['tsc', '-p', 'tsconfig.build.json', '--incremental', 'false'], {
        cwd: `${meowboxDir}/api`,
        timeout: 120_000,
        allowFailure: true,
      });
      if (apiBuild.exitCode !== 0) {
        log(`[update] API build warning: ${apiBuild.stderr}`);
      }

      // Step 5: Build Agent
      log('[update] Building Agent...');
      const agentBuild = await this.cmd.execute('npx', ['tsc'], {
        cwd: `${meowboxDir}/agent`,
        timeout: 120_000,
        allowFailure: true,
      });
      if (agentBuild.exitCode !== 0) {
        log(`[update] Agent build warning: ${agentBuild.stderr}`);
      }

      // Step 6: Build Web
      log('[update] Building Web...');
      const webBuild = await this.cmd.execute('npx', ['nuxt', 'build'], {
        cwd: `${meowboxDir}/web`,
        timeout: 300_000,
        allowFailure: true,
      });
      if (webBuild.exitCode !== 0) {
        log(`[update] Web build warning: ${webBuild.stderr}`);
      }

      // Step 7: Restart PM2 processes
      log('[update] Restarting services...');
      await this.cmd.execute('pm2', ['restart', 'all'], { timeout: 30_000, allowFailure: true });

      log('[update] Self-update completed successfully');
      return { success: true, output: output.join('\n') };
    } catch (err) {
      return { success: false, error: (err as Error).message, output: output.join('\n') };
    }
  }

  /**
   * Get installed versions of key software components.
   */
  async getVersions(): Promise<{ success: boolean; data?: Record<string, string>; error?: string }> {
    try {
      const versions: Record<string, string> = {};

      // Node.js
      versions.nodejs = process.version;

      // Все version-пробы могут падать на хостах где софт не установлен —
      // это валидный сценарий «версия не известна», не ошибка → allowFailure.
      const nginx = await this.cmd.execute('nginx', ['-v'], { timeout: 5000, allowFailure: true });
      const nginxMatch = (nginx.stderr || nginx.stdout).match(/nginx\/(\S+)/);
      if (nginxMatch) versions.nginx = nginxMatch[1];

      // PHP (check multiple versions — список из config.ts / env SUPPORTED_PHP_VERSIONS)
      for (const ver of SUPPORTED_PHP_VERSIONS) {
        const php = await this.cmd.execute(`php${ver}`, ['-v'], { timeout: 5000, allowFailure: true });
        if (php.exitCode === 0) {
          const phpMatch = php.stdout.match(/PHP\s+(\S+)/);
          if (phpMatch) versions[`php${ver}`] = phpMatch[1];
        }
      }

      // MariaDB
      const maria = await this.cmd.execute('mariadb', ['--version'], { timeout: 5000, allowFailure: true });
      const mariaMatch = maria.stdout.match(/(\d+\.\d+\.\d+)/);
      if (mariaMatch) versions.mariadb = mariaMatch[1];

      // PostgreSQL
      const pg = await this.cmd.execute('psql', ['--version'], { timeout: 5000, allowFailure: true });
      const pgMatch = pg.stdout.match(/(\d+\.\d+)/);
      if (pgMatch) versions.postgresql = pgMatch[1];

      // PM2
      const pm2 = await this.cmd.execute('pm2', ['--version'], { timeout: 5000, allowFailure: true });
      versions.pm2 = pm2.stdout.trim();

      return { success: true, data: versions };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}
