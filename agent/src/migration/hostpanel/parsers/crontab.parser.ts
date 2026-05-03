/**
 * Парсер crontab из источника. Принимает сырой текст `crontab -u <user> -l`,
 * фильтрует системный мусор (dumper, certbot, letsencrypt, fail2ban-cleanup),
 * умеет вырезать префикс `sudo -u<username>` и определять, к какому сайту
 * относится строка (по упоминанию /var/www/<user>/ в команде).
 *
 * Возвращает структуру {bySite: Map<user, []>, system: []} — миграционный
 * сервис уже распределяет по PlanItem.cronJobs / DiscoveryResult.systemCronJobs.
 */

import type { PlanItemCronJob } from '../types';

const SCHEDULE_RE = /^(@\w+|(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+))\s+(.+)$/;
const COMMENT_RE = /^\s*#/;
const EMPTY_RE = /^\s*$/;

const SKIP_PATTERNS = [
  /\bdumper\b/i,
  /\bcertbot\b/i,
  /\bletsencrypt\b/i,
  /\bapt-get\s+autoremove\b/i,
  /\bcron-renew\b/i,
  /\bfail2ban-cleanup\b/i,
];

const SUDO_USER_RE = /^sudo\s+(?:-H\s+)?-u\s*([a-z_][a-z0-9_-]*)\s+/;
const SITE_PATH_RE = /\/var\/www\/([a-z_][a-z0-9_-]*)\//;

export interface ParsedCrontab {
  /** Per-site cron'ы — ключ: linux user сайта на источнике. */
  bySite: Map<string, PlanItemCronJob[]>;
  /** Системные cron'ы (root) — без привязки к сайту. */
  system: PlanItemCronJob[];
}

export function parseCrontab(
  raw: string,
  fromUser: 'root' | string,
  knownSiteUsers: Set<string>,
): ParsedCrontab {
  const bySite = new Map<string, PlanItemCronJob[]>();
  const system: PlanItemCronJob[] = [];

  const lines = raw.split('\n');
  for (const line of lines) {
    if (COMMENT_RE.test(line) || EMPTY_RE.test(line)) continue;

    // Skip системный мусор
    if (SKIP_PATTERNS.some((re) => re.test(line))) continue;

    // Извлекаем расписание + команду
    const m = line.match(SCHEDULE_RE);
    if (!m) continue;
    const schedule = m[1]!;
    let command = m[7]!;
    let noteStripped: string | undefined;

    // Обрезаем `sudo -u<user>` при необходимости — определяем target по этому юзеру
    let targetUser = fromUser;
    const sudoMatch = command.match(SUDO_USER_RE);
    if (sudoMatch?.[1]) {
      targetUser = sudoMatch[1];
      noteStripped = `sudo -u${targetUser} (зачищен)`;
      command = command.replace(SUDO_USER_RE, '');
    }

    // Определяем target: this-site (если targetUser совпадает с known) | system-root
    let target: PlanItemCronJob['target'] = 'system-root';
    let attachToUser: string | null = null;

    if (knownSiteUsers.has(targetUser)) {
      target = 'this-site';
      attachToUser = targetUser;
    } else {
      // Может быть путь /var/www/<user>/ внутри команды — тогда привязываем к этому сайту
      const pathMatch = command.match(SITE_PATH_RE);
      if (pathMatch?.[1] && knownSiteUsers.has(pathMatch[1])) {
        target = 'this-site';
        attachToUser = pathMatch[1];
      }
    }

    const job: PlanItemCronJob = {
      raw: line,
      schedule,
      command: command.trim(),
      fromUser,
      target,
      noteStripped,
    };

    if (target === 'this-site' && attachToUser) {
      const arr = bySite.get(attachToUser) || [];
      arr.push(job);
      bySite.set(attachToUser, arr);
    } else {
      system.push(job);
    }
  }

  return { bySite, system };
}
