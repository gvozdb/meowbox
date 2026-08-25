import type { Prisma } from '@prisma/client';

/**
 * SQL query output is intentionally opt-in: it is useful for short diagnostics,
 * but every background query otherwise becomes a PM2 stdout log line.
 */
export function resolvePrismaLogLevels(
  queryLogging = process.env.PRISMA_LOG_QUERIES,
): Prisma.LogLevel[] {
  if (queryLogging?.trim().toLowerCase() === 'true') {
    return ['query', 'error', 'warn'];
  }
  return ['error'];
}
