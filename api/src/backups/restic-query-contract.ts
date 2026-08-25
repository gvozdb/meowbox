import { OperationNeedsAttentionError } from '../operations/operation-errors';

export const RESTIC_QUERY_ACTIONS = {
  SNAPSHOTS: 'backup.restic.snapshots.list',
  BACKUP_TREE: 'backup.restic.backup_tree.list',
  SNAPSHOT_TREE: 'backup.restic.snapshot_tree.list',
  DIFF_SNAPSHOTS: 'backup.restic.diff.snapshots',
  DIFF_LIVE: 'backup.restic.diff.live',
  DIFF_FILE: 'backup.restic.diff.file',
  DIFF_FILE_LIVE: 'backup.restic.diff.file_live',
} as const;

export const RESTIC_QUERY_AGENT_ACTIONS = {
  SNAPSHOTS: 'agent.restic.snapshots',
  TREE: 'agent.restic.list_tree',
  DIFF_SNAPSHOTS: 'agent.restic.diff_snapshots',
  DIFF_LIVE: 'agent.restic.diff_live',
  DIFF_FILE: 'agent.restic.diff_file',
  DIFF_FILE_LIVE: 'agent.restic.diff_file_live',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_ID = /^[a-f0-9]{6,64}$/i;
const CONTROL = /[\0-\x1f\x7f]/;
const MAX_RESULT_BYTES = 900 * 1024;

export interface ResticSnapshotsRequest {
  siteId: string;
  locationId: string;
}

export interface ResticBackupTreeRequest {
  siteId: string;
  backupId: string;
}

export interface ResticSnapshotTreeRequest extends ResticSnapshotsRequest {
  snapshotId: string;
}

export interface ResticDiffSnapshotsRequest extends ResticSnapshotsRequest {
  snapshotIdA: string;
  snapshotIdB: string;
}

export interface ResticDiffLiveRequest extends ResticSnapshotsRequest {
  snapshotId: string;
}

export interface ResticDiffFileRequest extends ResticDiffSnapshotsRequest {
  filePath: string;
}

export interface ResticDiffFileLiveRequest extends ResticDiffLiveRequest {
  filePath: string;
}

export interface ResticSnapshotResult {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  paths: string[];
  tags?: string[];
  summary?: Record<string, number>;
  inDatabase?: boolean;
}

export interface ResticTreeItemResult {
  name: string;
  type: 'dir' | 'file';
  size: number;
}

export interface ResticDiffResult {
  items: Array<{ path: string; modifier: string }>;
  stats: Record<string, number>;
}

export interface ResticFileDiffResult {
  binary: boolean;
  sizeA: number;
  sizeB: number;
  unifiedDiff: string;
  truncated: boolean;
}

function invalid(message: string): never {
  throw new OperationNeedsAttentionError(message);
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], message: string): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid(message);
}

function uuid(value: unknown, message: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(message);
  return value;
}

function snapshotId(value: unknown, message: string): string {
  if (typeof value !== 'string' || !SNAPSHOT_ID.test(value)) invalid(message);
  return value;
}

function filePath(value: unknown, message: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    CONTROL.test(value) ||
    value.split('/').includes('..')
  ) invalid(message);
  return value;
}

function boundedString(value: unknown, max: number, message: string): string {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) invalid(message);
  return value;
}

function nonNegativeInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(message);
  return value;
}

function assertResultBudget(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESULT_BYTES) {
    invalid('Restic query result exceeds durable result budget');
  }
}

export function parseResticSnapshotsRequest(value: unknown): ResticSnapshotsRequest {
  const input = record(value, 'Restic snapshots request is invalid');
  exactKeys(input, ['siteId', 'locationId'], 'Restic snapshots request is invalid');
  return {
    siteId: uuid(input.siteId, 'Restic snapshots request is invalid'),
    locationId: uuid(input.locationId, 'Restic snapshots request is invalid'),
  };
}

export function parseResticBackupTreeRequest(value: unknown): ResticBackupTreeRequest {
  const input = record(value, 'Restic backup tree request is invalid');
  exactKeys(input, ['siteId', 'backupId'], 'Restic backup tree request is invalid');
  return {
    siteId: uuid(input.siteId, 'Restic backup tree request is invalid'),
    backupId: uuid(input.backupId, 'Restic backup tree request is invalid'),
  };
}

export function parseResticSnapshotTreeRequest(value: unknown): ResticSnapshotTreeRequest {
  const input = record(value, 'Restic snapshot tree request is invalid');
  exactKeys(input, ['siteId', 'locationId', 'snapshotId'], 'Restic snapshot tree request is invalid');
  return {
    siteId: uuid(input.siteId, 'Restic snapshot tree request is invalid'),
    locationId: uuid(input.locationId, 'Restic snapshot tree request is invalid'),
    snapshotId: snapshotId(input.snapshotId, 'Restic snapshot tree request is invalid'),
  };
}

export function parseResticDiffSnapshotsRequest(value: unknown): ResticDiffSnapshotsRequest {
  const input = record(value, 'Restic snapshot diff request is invalid');
  exactKeys(
    input,
    ['siteId', 'locationId', 'snapshotIdA', 'snapshotIdB'],
    'Restic snapshot diff request is invalid',
  );
  const parsed = {
    siteId: uuid(input.siteId, 'Restic snapshot diff request is invalid'),
    locationId: uuid(input.locationId, 'Restic snapshot diff request is invalid'),
    snapshotIdA: snapshotId(input.snapshotIdA, 'Restic snapshot diff request is invalid'),
    snapshotIdB: snapshotId(input.snapshotIdB, 'Restic snapshot diff request is invalid'),
  };
  if (parsed.snapshotIdA === parsed.snapshotIdB) invalid('Restic snapshots are identical');
  return parsed;
}

export function parseResticDiffLiveRequest(value: unknown): ResticDiffLiveRequest {
  return parseResticSnapshotTreeRequest(value);
}

export function parseResticDiffFileRequest(value: unknown): ResticDiffFileRequest {
  const input = record(value, 'Restic file diff request is invalid');
  exactKeys(
    input,
    ['siteId', 'locationId', 'snapshotIdA', 'snapshotIdB', 'filePath'],
    'Restic file diff request is invalid',
  );
  const parsed = parseResticDiffSnapshotsRequest({
    siteId: input.siteId,
    locationId: input.locationId,
    snapshotIdA: input.snapshotIdA,
    snapshotIdB: input.snapshotIdB,
  });
  return { ...parsed, filePath: filePath(input.filePath, 'Restic file diff request is invalid') };
}

export function parseResticDiffFileLiveRequest(value: unknown): ResticDiffFileLiveRequest {
  const input = record(value, 'Restic live file diff request is invalid');
  exactKeys(
    input,
    ['siteId', 'locationId', 'snapshotId', 'filePath'],
    'Restic live file diff request is invalid',
  );
  const parsed = parseResticDiffLiveRequest({
    siteId: input.siteId,
    locationId: input.locationId,
    snapshotId: input.snapshotId,
  });
  return { ...parsed, filePath: filePath(input.filePath, 'Restic live file diff request is invalid') };
}

export function validateResticSnapshotsResult(value: unknown): ResticSnapshotResult[] {
  const result = record(value, 'Restic snapshots result is invalid');
  const snapshots = result.snapshots;
  if (!Array.isArray(snapshots) || snapshots.length > 5_000) {
    invalid('Restic snapshots result is invalid');
  }
  const parsed = snapshots.map((entry) => {
    const item = record(entry, 'Restic snapshot result is invalid');
    const id = snapshotId(item.id, 'Restic snapshot result is invalid');
    const shortId = snapshotId(item.short_id, 'Restic snapshot result is invalid');
    const time = boundedString(item.time, 64, 'Restic snapshot result is invalid');
    if (!Number.isFinite(Date.parse(time))) invalid('Restic snapshot result is invalid');
    const hostname = boundedString(item.hostname, 255, 'Restic snapshot result is invalid');
    if (!Array.isArray(item.paths) || item.paths.length > 64) invalid('Restic snapshot result is invalid');
    const paths = item.paths.map((path) => boundedString(path, 4096, 'Restic snapshot result is invalid'));
    let tags: string[] | undefined;
    if (item.tags !== undefined) {
      if (!Array.isArray(item.tags) || item.tags.length > 64) invalid('Restic snapshot result is invalid');
      tags = item.tags.map((tag) => boundedString(tag, 256, 'Restic snapshot result is invalid'));
    }
    let summary: Record<string, number> | undefined;
    if (item.summary !== undefined) {
      const source = record(item.summary, 'Restic snapshot summary is invalid');
      if (Object.keys(source).length > 16) invalid('Restic snapshot summary is invalid');
      summary = {};
      for (const [key, number] of Object.entries(source)) {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) invalid('Restic snapshot summary is invalid');
        summary[key] = nonNegativeInteger(number, 'Restic snapshot summary is invalid');
      }
    }
    return { id, short_id: shortId, time, hostname, paths, ...(tags ? { tags } : {}), ...(summary ? { summary } : {}) };
  });
  assertResultBudget(parsed);
  return parsed;
}

export function validateResticTreeResult(value: unknown): ResticTreeItemResult[] {
  const result = record(value, 'Restic tree result is invalid');
  const items = result.items;
  if (!Array.isArray(items) || items.length > 20_000) invalid('Restic tree result is invalid');
  const parsed = items.map((entry) => {
    const item = record(entry, 'Restic tree item is invalid');
    exactKeys(item, ['name', 'type', 'size'], 'Restic tree item is invalid');
    const name = boundedString(item.name, 255, 'Restic tree item is invalid');
    if (!name || name === '.' || name === '..' || name.includes('/')) invalid('Restic tree item is invalid');
    if (item.type !== 'dir' && item.type !== 'file') invalid('Restic tree item is invalid');
    const type = item.type as 'dir' | 'file';
    return {
      name,
      type,
      size: nonNegativeInteger(item.size, 'Restic tree item is invalid'),
    };
  });
  assertResultBudget(parsed);
  return parsed;
}

export function validateResticDiffResult(value: unknown): ResticDiffResult {
  const result = record(value, 'Restic diff result is invalid');
  exactKeys(result, ['items', 'stats'], 'Restic diff result is invalid');
  if (!Array.isArray(result.items) || result.items.length > 20_000) invalid('Restic diff result is invalid');
  const items = result.items.map((entry) => {
    const item = record(entry, 'Restic diff item is invalid');
    exactKeys(item, ['path', 'modifier'], 'Restic diff item is invalid');
    const path = filePath(item.path, 'Restic diff item is invalid');
    const modifier = boundedString(item.modifier, 8, 'Restic diff item is invalid');
    if (!['+', '-', 'M', 'T', 'U'].includes(modifier)) invalid('Restic diff item is invalid');
    return { path, modifier };
  });
  const statsSource = record(result.stats, 'Restic diff stats are invalid');
  if (Object.keys(statsSource).length > 16) invalid('Restic diff stats are invalid');
  const stats: Record<string, number> = {};
  for (const [key, number] of Object.entries(statsSource)) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key)) invalid('Restic diff stats are invalid');
    stats[key] = nonNegativeInteger(number, 'Restic diff stats are invalid');
  }
  const parsed = { items, stats };
  assertResultBudget(parsed);
  return parsed;
}

export function validateResticFileDiffResult(value: unknown): ResticFileDiffResult {
  const result = record(value, 'Restic file diff result is invalid');
  if (Object.keys(result).some((key) => !['binary', 'sizeA', 'sizeB', 'unifiedDiff', 'truncated'].includes(key))) {
    invalid('Restic file diff result is invalid');
  }
  const binary = result.binary === true;
  const truncated = result.truncated === true;
  const sizeA = nonNegativeInteger(result.sizeA ?? 0, 'Restic file diff result is invalid');
  const sizeB = nonNegativeInteger(result.sizeB ?? 0, 'Restic file diff result is invalid');
  const unifiedDiff = boundedString(result.unifiedDiff ?? '', 768 * 1024, 'Restic file diff result is invalid');
  const parsed = { binary, sizeA, sizeB, unifiedDiff, truncated };
  assertResultBudget(parsed);
  return parsed;
}
