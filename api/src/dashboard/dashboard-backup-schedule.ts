import { CronExpressionParser } from 'cron-parser';

export type DashboardCronState =
  | { state: 'NOT_DUE' }
  | { state: 'INVALID' }
  | { state: 'DUE'; expectedAt: Date; missedExecutions: number };

export function dashboardCronState(
  schedule: string,
  baseDate: Date,
  now: Date,
  timezone = process.env.TZ || 'UTC',
): DashboardCronState {
  try {
    const expression = CronExpressionParser.parse(schedule, {
      currentDate: baseDate,
      tz: timezone,
    });
    const expectedAt = expression.next().toDate();
    const following = CronExpressionParser.parse(schedule, {
      currentDate: expectedAt,
      tz: timezone,
    }).next().toDate();
    const intervalMs = Math.max(60_000, following.getTime() - expectedAt.getTime());
    const graceMs = Math.max(15 * 60_000, Math.floor(intervalMs * 0.25));
    if (now.getTime() <= expectedAt.getTime() + graceMs) return { state: 'NOT_DUE' };

    let missedExecutions = 1;
    let cursor = expectedAt;
    while (missedExecutions < 3) {
      const next = CronExpressionParser.parse(schedule, {
        currentDate: cursor,
        tz: timezone,
      }).next().toDate();
      if (now.getTime() <= next.getTime() + graceMs) break;
      cursor = next;
      missedExecutions += 1;
    }
    return { state: 'DUE', expectedAt, missedExecutions };
  } catch {
    return { state: 'INVALID' };
  }
}
