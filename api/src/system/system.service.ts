import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import * as os from 'os';

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  async getStatus() {
    const dbStatus = await this.checkDatabase();

    return {
      status: dbStatus === 'up' ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      versions: {
        api: process.env.npm_package_version || '0.1.0',
        node: process.version,
      },
      services: {
        database: dbStatus,
      },
    };
  }

  async getMetrics() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const uptimeSeconds = os.uptime();

    // Compute average CPU usage across all cores
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      const { user, nice, sys, idle, irq } = cpu.times;
      totalIdle += idle;
      totalTick += user + nice + sys + idle + irq;
    }
    const cpuUsagePercent = totalTick > 0
      ? Math.round(((totalTick - totalIdle) / totalTick) * 100)
      : 0;

    return {
      cpuUsagePercent,
      cpuCores: cpus.length,
      memoryTotalBytes: totalMem,
      memoryUsedBytes: usedMem,
      memoryFreeBytes: freeMem,
      memoryUsagePercent: Math.round((usedMem / totalMem) * 100),
      uptimeSeconds: Math.floor(uptimeSeconds),
      loadAverage: os.loadavg(),
    };
  }

  private async checkDatabase(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  async checkUpdates() {
    const result = await this.agentRelay.emitToAgent('updates:check', {}, 180_000);
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to check updates');
    }
    return result.data;
  }

  async installUpdates(packages: string[]) {
    const result = await this.agentRelay.emitToAgent('updates:install', { packages }, 360_000);
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to install updates');
    }
    return result.data;
  }

  async upgradeAll() {
    const result = await this.agentRelay.emitToAgent('updates:upgrade-all', {}, 600_000);
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to upgrade');
    }
    return result.data;
  }

  async getVersions() {
    const result = await this.agentRelay.emitToAgent('updates:versions', {}, 30_000);
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to get versions');
    }
    return result.data;
  }

  async selfUpdate() {
    const result = await this.agentRelay.emitToAgent<{ output: string }>('updates:self-update', {}, 600_000);
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Self-update failed');
    }
    return result.data;
  }
}
