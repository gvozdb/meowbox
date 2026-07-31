import type { Diagnostic, JsonObject, JsonValue } from './types';
import { REDACTED } from './types';

const SENSITIVE_KEY = /(?:password|passwd|secret|token|credential|authorization|cookie|private[_-]?key|ssh[_-]?key|env(?:[_-]?vars)?|connection[_-]?string)/i;
const URI_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi;

/**
 * Reports intentionally carry IDs, hashes and counts, never encrypted values
 * or configuration blobs. This defensive pass protects future additions too.
 */
export function redactJson(value: JsonValue, key?: string): JsonValue {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return value.replace(URI_CREDENTIALS, '$1[REDACTED]@');
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redactJson(childValue, childKey);
    }
    return output;
  }
  return value;
}

export function redactDiagnostic(diagnostic: Diagnostic): Diagnostic {
  if (diagnostic.details === undefined) return diagnostic;
  return {
    ...diagnostic,
    details: redactJson(diagnostic.details) as JsonObject,
  };
}

export function redactDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return diagnostics.map(redactDiagnostic);
}

/** Avoid dumping sqlite's SQL/error text into an operator-visible report. */
export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(URI_CREDENTIALS, '$1[REDACTED]@')
    .replace(/(?:password|secret|token|credential)\s*=\s*[^\s,;]+/gi, '$&'.split('=')[0] + '=[REDACTED]')
    .slice(0, 800);
}
