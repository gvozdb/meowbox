import type { DashboardOverview, DashboardSourceState } from '@meowbox/shared';

export type TelegramCommand =
  | 'status'
  | 'problems'
  | 'resources'
  | 'sites'
  | 'services'
  | 'backups'
  | 'ssl'
  | 'help'
  | 'whoami';

const COMMANDS = new Set<TelegramCommand>([
  'status',
  'problems',
  'resources',
  'sites',
  'services',
  'backups',
  'ssl',
  'help',
  'whoami',
]);

const MAX_TELEGRAM_TEXT_LENGTH = 3900;

export interface ParsedTelegramCommand {
  command: TelegramCommand | 'unknown';
  botUsername: string | null;
}

export function parseTelegramCommand(text: unknown): ParsedTelegramCommand | null {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const match = text.trim().match(
    /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s.*)?$/s,
  );
  if (!match) return null;
  const name = match[1].toLowerCase() as TelegramCommand;
  return {
    command: COMMANDS.has(name) ? name : 'unknown',
    botUsername: match[2]?.toLowerCase() ?? null,
  };
}

export function formatTelegramHelp(): string {
  return [
    '<b>Информационные команды Meowbox</b>',
    '',
    '<code>/status</code> — состояние панели и сервера',
    '<code>/problems</code> — актуальные проблемы',
    '<code>/resources</code> — CPU, RAM, диски, сеть',
    '<code>/sites</code> — сайты и домены',
    '<code>/services</code> — системные сервисы',
    '<code>/backups</code> — состояние бэкапов',
    '<code>/ssl</code> — сертификаты',
    '<code>/whoami</code> — Telegram ID для привязки',
  ].join('\n');
}

export function formatDashboardCommand(
  command: Exclude<TelegramCommand, 'help' | 'whoami'>,
  overview: DashboardOverview,
): string {
  switch (command) {
    case 'status':
      return formatStatus(overview);
    case 'problems':
      return formatProblems(overview);
    case 'resources':
      return formatResources(overview);
    case 'sites':
      return formatSites(overview);
    case 'services':
      return formatServices(overview);
    case 'backups':
      return formatBackups(overview);
    case 'ssl':
      return formatSsl(overview);
  }
}

function formatStatus(overview: DashboardOverview): string {
  const rootDisk = overview.resources.disks.find((disk) => disk.mountPoint === '/')
    ?? overview.resources.disks[0];
  const lines = [
    `${overallIcon(overview.overall.state)} <b>${escapeHtml(overview.server.displayName)}</b> — ${overallLabel(overview.overall.state)}`,
    `Агент: <b>${escapeHtml(overview.server.agentState)}</b>`,
    `Uptime: <b>${formatDuration(overview.server.uptimeSeconds)}</b>`,
    `Проблемы: 🔴 ${overview.problems.critical} · 🟠 ${overview.problems.warning} · 🔵 ${overview.problems.info}`,
    `CPU: <b>${formatPercent(overview.resources.cpuUsagePercent)}</b> · RAM: <b>${formatPercent(overview.resources.memoryUsagePercent)}</b>`,
    `Диск${rootDisk ? ` ${escapeHtml(rootDisk.mountPoint)}` : ''}: <b>${rootDisk ? formatPercent(rootDisk.usagePercent) : '—'}</b>`,
    sourceWarning(overview.resources.source),
    observedLine(overview.generatedAt),
  ].filter(Boolean) as string[];
  return boundedMessage(lines);
}

function formatProblems(overview: DashboardOverview): string {
  const header = [
    '<b>Проблемы</b>',
    `Всего: ${overview.problems.total} · 🔴 ${overview.problems.critical} · 🟠 ${overview.problems.warning} · 🔵 ${overview.problems.info}`,
  ];
  if (overview.problems.items.length === 0) {
    return boundedMessage([...header, '', '✅ Активных проблем нет', observedLine(overview.generatedAt)]);
  }

  const items = overview.problems.items.slice(0, 10).map((problem) => {
    const summary = truncate(problem.summary, 170);
    return `${severityIcon(problem.severity)} <b>${escapeHtml(truncate(problem.title, 90))}</b>\n${escapeHtml(truncate(problem.entity.label, 100))}: ${escapeHtml(summary)}`;
  });
  const omitted = overview.problems.total - items.length;
  return boundedMessage([
    ...header,
    '',
    ...interleave(items),
    ...(omitted > 0 ? [`Ещё: ${omitted}`] : []),
    observedLine(overview.generatedAt),
  ]);
}

function formatResources(overview: DashboardOverview): string {
  const resources = overview.resources;
  const lines = [
    '<b>Ресурсы сервера</b>',
    `CPU: <b>${formatPercent(resources.cpuUsagePercent)}</b>${resources.cpuCores ? ` · ${resources.cpuCores} cores` : ''}`,
    `RAM: <b>${formatPercent(resources.memoryUsagePercent)}</b> · ${formatBytes(resources.memoryUsedBytes)} / ${formatBytes(resources.memoryTotalBytes)}`,
    `Load: <b>${resources.loadAverage?.map((value) => value.toFixed(2)).join(' · ') ?? '—'}</b>`,
    '',
    ...resources.disks.slice(0, 8).map(
      (disk) => `💾 ${escapeHtml(disk.mountPoint)}: <b>${formatPercent(disk.usagePercent)}</b> · ${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`,
    ),
    resources.network
      ? `Сеть: ↓ ${formatBytes(resources.network.rxBytesPerSecond)}/s · ↑ ${formatBytes(resources.network.txBytesPerSecond)}/s`
      : 'Сеть: —',
    sourceWarning(resources.source),
    observedLine(resources.collectedAt ?? overview.generatedAt),
  ].filter(Boolean) as string[];
  return boundedMessage(lines);
}

function formatSites(overview: DashboardOverview): string {
  const sites = overview.sites;
  const exceptions = sites.items.filter(
    (site) => site.status !== 'RUNNING' || site.activeOperation,
  );
  return boundedMessage([
    '<b>Сайты</b>',
    `Всего: <b>${sites.total}</b> · ✅ ${sites.running} · ❌ ${sites.error} · ⏳ ${sites.deploying}`,
    `Управляемых доменов: <b>${sites.managedDomains}</b>`,
    ...(exceptions.length > 0 ? ['', ...exceptions.map(
      (site) => `${site.status === 'ERROR' ? '❌' : '⏳'} ${escapeHtml(site.displayName)} — <b>${escapeHtml(site.status)}</b>`,
    )] : ['', '✅ Ошибок и активных операций нет']),
    sourceWarning(sites.source),
    observedLine(overview.generatedAt),
  ].filter(Boolean) as string[]);
}

function formatServices(overview: DashboardOverview): string {
  if (overview.role !== 'ADMIN') {
    return '<b>Сервисы</b>\nНедоступно для роли MANAGER.';
  }
  const services = overview.runtime.services;
  return boundedMessage([
    '<b>Системные сервисы</b>',
    ...(services.length > 0
      ? services.map((service) => `${serviceIcon(service.actualState)} ${escapeHtml(service.name)} — <b>${escapeHtml(service.actualState)}</b>`)
      : ['Данные о сервисах отсутствуют']),
    overview.runtime.diagnosticsPartial ? '⚠️ Диагностика частичная' : '',
    sourceWarning(overview.runtime.source),
    observedLine(overview.runtime.source.observedAt ?? overview.generatedAt),
  ].filter(Boolean) as string[]);
}

function formatBackups(overview: DashboardOverview): string {
  const backup = overview.protection.backup;
  return boundedMessage([
    '<b>Бэкапы</b>',
    `Защищено сайтов: <b>${backup.protectedSiteCount} / ${backup.eligibleSiteCount}</b>`,
    `Ошибок за 24 часа: <b>${backup.failedLast24Hours}</b>`,
    `Просроченных расписаний: <b>${backup.overdueScheduleCount}</b>`,
    `Активных задач: <b>${backup.activeCount}</b>`,
    `Репозиторий: <b>${escapeHtml(backup.repositoryCheckState)}</b>`,
    `Последний успешный: <b>${formatTimestamp(backup.latestSuccessfulAt)}</b>`,
    sourceWarning(overview.protection.source),
    observedLine(overview.generatedAt),
  ].filter(Boolean) as string[]);
}

function formatSsl(overview: DashboardOverview): string {
  const ssl = overview.protection.ssl;
  const exceptions = ssl.exceptions.slice(0, 8).map(
    (item) => `⚠️ ${escapeHtml(item.domain)} — <b>${escapeHtml(item.status)}</b>${item.daysRemaining === null ? '' : ` · ${item.daysRemaining} дн.`}`,
  );
  return boundedMessage([
    '<b>SSL</b>',
    `Действуют: <b>${ssl.valid}</b> · Истекают: <b>${ssl.expiring}</b> · Ошибки/истекли: <b>${ssl.expiredOrError}</b>`,
    `Ближайший: <b>${ssl.nearestExpiryDomain ? escapeHtml(ssl.nearestExpiryDomain) : '—'}</b>${ssl.nearestExpiryDays === null ? '' : ` · ${ssl.nearestExpiryDays} дн.`}`,
    ...(exceptions.length > 0 ? ['', ...exceptions] : []),
    sourceWarning(overview.protection.source),
    observedLine(overview.generatedAt),
  ].filter(Boolean) as string[]);
}

function sourceWarning(source: DashboardSourceState): string {
  if (source.availability === 'OK') return '';
  const message = source.message ? `: ${escapeHtml(truncate(source.message, 160))}` : '';
  return `⚠️ Источник ${escapeHtml(source.availability)}${message}`;
}

function observedLine(value: string): string {
  return `<i>Снимок: ${formatTimestamp(value)}</i>`;
}

function boundedMessage(lines: string[]): string {
  const result: string[] = [];
  for (const line of lines) {
    const candidate = [...result, line].join('\n');
    if (candidate.length > MAX_TELEGRAM_TEXT_LENGTH) break;
    result.push(line);
  }
  return result.join('\n');
}

function interleave(items: string[]): string[] {
  return items.flatMap((item, index) => index === items.length - 1 ? [item] : [item, '']);
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`;
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = amount >= 100 || unit === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} д. ${hours} ч.`;
  if (hours > 0) return `${hours} ч. ${minutes} мин.`;
  return `${minutes} мин.`;
}

function formatTimestamp(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function overallIcon(value: DashboardOverview['overall']['state']): string {
  return value === 'HEALTHY' ? '✅' : value === 'CRITICAL' ? '🔴' : value === 'ATTENTION' ? '🟠' : '⚪';
}

function overallLabel(value: DashboardOverview['overall']['state']): string {
  const labels = {
    HEALTHY: 'в норме',
    ATTENTION: 'требует внимания',
    CRITICAL: 'критическое состояние',
    UNKNOWN: 'состояние неизвестно',
  } as const;
  return labels[value];
}

function severityIcon(value: string): string {
  return value === 'CRITICAL' ? '🔴' : value === 'WARNING' ? '🟠' : '🔵';
}

function serviceIcon(value: string): string {
  return value === 'RUNNING' ? '✅' : value === 'STOPPED' ? '⏹' : value === 'FAILED' ? '❌' : '⚪';
}
