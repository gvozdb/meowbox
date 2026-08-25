const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const DEFAULT_TRANSFER_MAX_BYTES = 50 * GIB;
const TRANSFER_UPLOAD_PATH = /^\/api\/public\/v1\/transfers\/[0-9a-f-]{36}\/upload(?:\?|$)/i;

export interface PayloadBudgetRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

function positiveSafeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function declaredContentLength(value: string | string[] | undefined): bigint | null {
  if (Array.isArray(value) || !/^(0|[1-9]\d*)$/.test(value ?? '')) return null;
  return BigInt(value!);
}

export function requestBodyBudget(
  request: PayloadBudgetRequest,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const url = request.url ?? '';
  const method = (request.method ?? 'GET').toUpperCase();
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (
    method === 'PUT' &&
    TRANSFER_UPLOAD_PATH.test(url) &&
    contentType === 'application/octet-stream'
  ) {
    return positiveSafeInteger(env.TRANSFER_MAX_ARTIFACT_BYTES, DEFAULT_TRANSFER_MAX_BYTES);
  }
  if (url.startsWith('/api/proxy/')) return MIB;
  if (contentType.includes('multipart/form-data')) {
    return positiveSafeInteger(env.API_UPLOAD_LIMIT_MB, DEFAULT_API_UPLOAD_LIMIT_MB) * MIB;
  }
  return positiveSafeInteger(env.API_JSON_LIMIT_MB, DEFAULT_API_JSON_LIMIT_MB) * MIB;
}
import {
  DEFAULT_API_JSON_LIMIT_MB,
  DEFAULT_API_UPLOAD_LIMIT_MB,
} from '@meowbox/shared';
