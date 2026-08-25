import { createHash } from 'crypto';

const MARKER_PREFIX = 'meowbox-managed:v1:';
const MARKER_PATTERN = /(?:^|\s)meowbox-managed:v1:([a-f0-9]{64})(?:\s|$)/i;

export interface ManagedDnsRecordShape {
  type: string;
  name: string;
  content: string;
  priority?: number | null;
  proxied?: boolean | null;
  comment?: string | null;
}

function canonicalScalar(value: string, type: string): string {
  const trimmed = value.trim();
  if (['CNAME', 'MX', 'NS'].includes(type)) {
    return trimmed.toLowerCase().replace(/\.$/, '');
  }
  if (type === 'SRV') {
    const parts = trimmed.split(/\s+/);
    if (parts.length > 0) {
      parts[parts.length - 1] = parts[parts.length - 1].toLowerCase().replace(/\.$/, '');
    }
    return parts.join(' ');
  }
  return trimmed;
}

function canonicalContent(value: string, type: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return canonicalScalar(trimmed, type);
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      return trimmed;
    }
    return JSON.stringify([...parsed].map((item) => canonicalScalar(item, type)).sort());
  } catch {
    return trimmed;
  }
}

export function managedDnsRecordHash(record: ManagedDnsRecordShape): string {
  const type = record.type.trim().toUpperCase();
  const canonical = JSON.stringify({
    type,
    name: record.name.trim().toLowerCase().replace(/\.$/, ''),
    content: canonicalContent(record.content, type),
    priority: record.priority ?? null,
    proxied: record.proxied === true,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function managedDnsExpectedHash(comment: string | null | undefined): string | null {
  return MARKER_PATTERN.exec(comment || '')?.[1]?.toLowerCase() ?? null;
}

export function withManagedDnsMarker<T extends ManagedDnsRecordShape>(record: T): T {
  const userComment = (record.comment || '')
    .replace(MARKER_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420);
  const marker = `${MARKER_PREFIX}${managedDnsRecordHash(record)}`;
  return {
    ...record,
    comment: userComment ? `${marker} ${userComment}` : marker,
  };
}

export function preserveManagedDnsMarker(
  previousComment: string | null | undefined,
  remoteComment: string | null | undefined,
): string | null {
  const expected = managedDnsExpectedHash(previousComment);
  if (!expected) return remoteComment ?? null;
  const remoteText = (remoteComment || '').replace(MARKER_PATTERN, ' ').trim();
  return remoteText
    ? `${MARKER_PREFIX}${expected} ${remoteText}`.slice(0, 512)
    : `${MARKER_PREFIX}${expected}`;
}
