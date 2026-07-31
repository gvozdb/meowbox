/**
 * Shared, JSON-safe types for the release migration preflight helpers.
 *
 * These helpers deliberately do not depend on Prisma. They are run before a
 * candidate release is allowed to mutate the panel database, so their only
 * database transport is the sqlite3 CLI in explicit read-only mode.
 */

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type DiagnosticSeverity = 'blocker' | 'warning' | 'info';

/** A safe-to-publish diagnostic. Never place a secret or raw SQL here. */
export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly details?: JsonObject;
}

export interface CheckReport {
  readonly ok: boolean;
  readonly blockers: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}

export type DatabaseWriteMode = 'clone' | 'live';

export interface DatabaseFileFingerprint {
  /** SHA-256 of the main SQLite database file. */
  readonly main: string;
  /** SHA-256 of an accompanying WAL file, if one exists. */
  readonly wal: string | null;
  /** SHA-256 of an accompanying SHM file, if one exists. */
  readonly shm: string | null;
  /** Stable digest over the three component hashes. */
  readonly combined: string;
}

export const REDACTED = '[REDACTED]' as const;

export function blocker(code: string, message: string, details?: JsonObject): Diagnostic {
  return details === undefined
    ? { code, severity: 'blocker', message }
    : { code, severity: 'blocker', message, details };
}

export function warning(code: string, message: string, details?: JsonObject): Diagnostic {
  return details === undefined
    ? { code, severity: 'warning', message }
    : { code, severity: 'warning', message, details };
}

export function reportOk(blockers: readonly Diagnostic[]): boolean {
  return blockers.length === 0;
}
