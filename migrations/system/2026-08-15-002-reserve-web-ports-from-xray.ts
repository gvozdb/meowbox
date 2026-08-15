import { createHash } from 'node:crypto';

import {
  RESERVED_WEB_TCP_PORTS,
  VpnProtocol,
  VpnServiceStatus,
} from '@meowbox/shared';

import type { MigrationContext, MigrationPlan, SystemMigration } from './_types';

const MIGRATION_ID = '2026-08-15-002-reserve-web-ports-from-xray';
const XRAY_SYSTEMD_PREFIX = 'meowbox-vpn-xray-';
const SERVICE_ID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

interface ReservedPortService {
  id: string;
  port: number;
  status: string;
}

function unitFor(serviceId: string): string {
  if (!SERVICE_ID_RE.test(serviceId)) {
    throw new Error(`Unsafe VPN service id in migration: ${serviceId}`);
  }
  return `${XRAY_SYSTEMD_PREFIX}${serviceId}.service`;
}

function stopReason(port: number): string {
  return (
    `Автоматически остановлен: TCP-порт ${port} зарезервирован для HTTP/HTTPS сайтов Meowbox. ` +
    'Создай VLESS Reality сервис на другом TCP-порту, например 8443.'
  );
}

async function reservedPortServices(ctx: MigrationContext): Promise<ReservedPortService[]> {
  return ctx.prisma.vpnService.findMany({
    where: {
      protocol: VpnProtocol.VLESS_REALITY,
      port: { in: [...RESERVED_WEB_TCP_PORTS] },
    },
    select: { id: true, port: true, status: true },
    orderBy: { id: 'asc' },
  });
}

function planFor(services: ReservedPortService[]): MigrationPlan {
  const ports = [...new Set(services.map((service) => service.port))].sort((a, b) => a - b);
  return {
    summary: services.length === 0
      ? 'No Xray services use HTTP/HTTPS ports'
      : `Stop ${services.length} Xray service(s) occupying reserved web port(s): ${ports.join(', ')}`,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(services.map(({ id, port, status }) => ({ id, port, status }))))
      .digest('hex'),
    details: { serviceCount: services.length, ports },
  };
}

async function runAllowFailure(
  ctx: MigrationContext,
  cmd: string,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  try {
    await ctx.exec.run(cmd, args);
    return { code: 0, stderr: '' };
  } catch (error) {
    const failed = error as { code?: number; stderr?: string; message?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stderr: failed.stderr ?? failed.message ?? '',
    };
  }
}

async function stopAndDisable(ctx: MigrationContext, unit: string): Promise<void> {
  const disable = await runAllowFailure(ctx, 'systemctl', ['disable', '--now', unit]);
  const active = await runAllowFailure(ctx, 'systemctl', ['is-active', '--quiet', unit]);
  if (active.code === 0) {
    throw new Error(`${unit} remains active after disable --now`);
  }

  const enabled = await runAllowFailure(ctx, 'systemctl', ['is-enabled', '--quiet', unit]);
  if (enabled.code === 0) {
    throw new Error(`${unit} remains enabled after disable`);
  }

  if (disable.code !== 0) {
    ctx.log(`WARN: ${unit} disable returned ${disable.code}: ${disable.stderr.slice(0, 200)}`);
  }
}

export function createXrayWebPortReservationMigration(): SystemMigration {
  return {
    id: MIGRATION_ID,
    description: 'Stop Xray services that occupy HTTP/HTTPS ports reserved for Nginx',

    async plan(ctx) {
      return planFor(await reservedPortServices(ctx));
    },

    async up(ctx) {
      const services = await reservedPortServices(ctx);
      if (services.length === 0) {
        ctx.log('OK: no Xray service occupies an HTTP/HTTPS port');
        return;
      }

      for (const service of services) {
        const unit = unitFor(service.id);
        if (ctx.dryRun) {
          ctx.log(`[dry-run] would disable ${unit} and mark VPN service ${service.id} stopped`);
          continue;
        }

        await stopAndDisable(ctx, unit);
        await ctx.prisma.vpnService.update({
          where: { id: service.id },
          data: {
            status: VpnServiceStatus.STOPPED,
            errorMessage: stopReason(service.port),
          },
        });
        ctx.log(`stopped ${unit}: TCP ${service.port} is reserved for Nginx`);
      }

      if (ctx.dryRun) return;

      await ctx.exec.run('nginx', ['-t']);
      await ctx.exec.run('systemctl', ['reload', 'nginx']);
      ctx.log('reloaded nginx after releasing reserved web port(s)');
    },
  };
}

const migration = createXrayWebPortReservationMigration();

export default migration;
