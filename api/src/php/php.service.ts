import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { AgentRelayService } from '../gateway/agent-relay.service';

export interface PhpVersionStatus {
  running: boolean;
  version: string | null;
  poolCount: number;
}

@Injectable()
export class PhpService {
  private readonly logger = new Logger('PhpService');

  constructor(private readonly agentRelay: AgentRelayService) {}

  async listVersions(): Promise<string[]> {
    const result = await this.agentRelay.emitToAgent<string[]>(
      'php:list-versions',
      {},
    );
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to list PHP versions',
      );
    }
    return result.data ?? [];
  }

  async getStatus(phpVersion: string): Promise<PhpVersionStatus> {
    const result = await this.agentRelay.emitToAgent<PhpVersionStatus>(
      'php:status',
      { phpVersion },
    );
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to get PHP status',
      );
    }
    return result.data!;
  }

  async getAllStatuses(): Promise<PhpVersionStatus[]> {
    const versions = await this.listVersions();
    const statuses: PhpVersionStatus[] = [];

    for (const ver of versions) {
      try {
        const status = await this.getStatus(ver);
        statuses.push(status);
      } catch {
        statuses.push({ running: false, version: ver, poolCount: 0 });
      }
    }

    return statuses;
  }

  async restartVersion(phpVersion: string): Promise<void> {
    const result = await this.agentRelay.emitToAgent('php:restart', {
      phpVersion,
    });
    if (!result.success) {
      throw new InternalServerErrorException(
        result.error || 'Failed to restart PHP-FPM',
      );
    }
    this.logger.log(`PHP-FPM ${phpVersion} restarted`);
  }

  async installVersion(version: string): Promise<void> {
    // Timeout > agent handler timeout (900s) + запас на сеть.
    // Иначе API отдаст timeout раньше, чем handler успеет вернуть результат.
    const result = await this.agentRelay.emitToAgent('php:install', { version }, 930_000);
    if (!result.success) throw new InternalServerErrorException(result.error || 'Install failed');
  }

  async uninstallVersion(version: string): Promise<void> {
    const result = await this.agentRelay.emitToAgent('php:uninstall', { version }, 630_000);
    if (!result.success) throw new InternalServerErrorException(result.error || 'Uninstall failed');
  }

  async readIni(version: string) {
    const result = await this.agentRelay.emitToAgent<string>('php:read-ini', { version });
    if (!result.success) throw new InternalServerErrorException(result.error || 'Read INI failed');
    return result.data;
  }

  async writeIni(version: string, content: string): Promise<void> {
    const result = await this.agentRelay.emitToAgent('php:write-ini', { version, content });
    if (!result.success) throw new InternalServerErrorException(result.error || 'Write INI failed');
  }

  async listExtensions(version: string) {
    const result = await this.agentRelay.emitToAgent<Array<{ name: string; enabled: boolean }>>('php:extensions', { version });
    if (!result.success) throw new InternalServerErrorException(result.error || 'List extensions failed');
    return result.data;
  }

  async installExtension(version: string, name: string): Promise<void> {
    // Handler timeout 240s (apt-get install one extension + restart fpm).
    // API timeout > handler timeout, чтобы API не выпал по timeout раньше.
    const result = await this.agentRelay.emitToAgent('php:extension-install', { version, name }, 270_000);
    if (!result.success) throw new InternalServerErrorException(result.error || 'Install extension failed');
  }

  async toggleExtension(version: string, name: string, enable: boolean): Promise<void> {
    const result = await this.agentRelay.emitToAgent('php:extension-toggle', { version, name, enable });
    if (!result.success) throw new InternalServerErrorException(result.error || 'Toggle extension failed');
  }
}
