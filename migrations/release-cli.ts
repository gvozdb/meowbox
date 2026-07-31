#!/usr/bin/env node
/**
 * Release-migration preflight CLI.
 *
 * It is intentionally separate from migrations/runner.ts: release preflight
 * must be able to inspect a SQLite clone before system migrations or runtime
 * configuration can change. Every command is read-only by default.
 */
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';

import {
  applyBaseline,
  applyLegacyMigrationMap,
  assessBaseline,
  baselineAssessmentJson,
  buildLegacyMigrationMap,
  checkMigrationInvariants,
  fingerprintDatabase,
  invariantReportJson,
  legacyMapReportJson,
  loadBaselineContract,
  loadBaselineCounts,
  loadRuntimeEvidence,
  parseBaselineCounts,
  safeErrorMessage,
  sortJson,
  stableJson,
  type DatabaseWriteMode,
  type JsonObject,
  type JsonValue,
} from './release';

type FlagName = 'json' | 'apply' | 'apply-map';

interface ParsedArgs {
  readonly command: string;
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<FlagName>;
}

interface CommandResult {
  readonly ok: boolean;
  readonly label: string;
  readonly payload: JsonObject;
}

class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const BOOLEAN_FLAGS = new Set<FlagName>(['json', 'apply', 'apply-map']);

function parseArguments(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  if (command === undefined || command.startsWith('-')) throw new CliUsageError(usage());
  const values = new Map<string, string>();
  const flags = new Set<FlagName>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new CliUsageError(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name as FlagName)) {
      if (flags.has(name as FlagName)) throw new CliUsageError(`Duplicate flag: --${name}`);
      flags.add(name as FlagName);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new CliUsageError(`--${name} requires a value`);
    if (values.has(name)) throw new CliUsageError(`Duplicate option: --${name}`);
    values.set(name, value);
    index += 1;
  }
  return { command, values, flags };
}

function requiredOption(parsed: ParsedArgs, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined || value.length === 0) throw new CliUsageError(`--${name} is required`);
  return value;
}

function optionalWriteMode(parsed: ParsedArgs): DatabaseWriteMode {
  const value = parsed.values.get('write-mode');
  if (value !== 'clone' && value !== 'live') {
    throw new CliUsageError('WRITE_MODE_REQUIRED: --write-mode clone|live is required with --apply or --apply-map');
  }
  return value;
}

async function writeReportAtomically(outputPath: string, payload: JsonObject): Promise<void> {
  const absolute = resolve(outputPath);
  const directory = dirname(absolute);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  const content = `${stableJson(payload)}\n`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, absolute);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function baselineCountsArgument(value: string): Promise<ReturnType<typeof parseBaselineCounts>> {
  if (value.trim().startsWith('{')) return parseBaselineCounts(JSON.parse(value));
  return loadBaselineCounts(value);
}

function publicFingerprint(schema: Awaited<ReturnType<typeof fingerprintDatabase>>): JsonObject {
  return {
    ok: true,
    kind: 'fingerprint',
    schemaSha256: schema.sha256,
    schema: schema.schema as unknown as JsonValue,
  };
}

async function runFingerprint(parsed: ParsedArgs): Promise<CommandResult> {
  const report = await fingerprintDatabase(requiredOption(parsed, 'db'));
  return { ok: true, label: 'fingerprint', payload: publicFingerprint(report) };
}

async function runBaseline(parsed: ParsedArgs): Promise<CommandResult> {
  const dbPath = requiredOption(parsed, 'db');
  const apiDir = requiredOption(parsed, 'api-dir');
  const contract = await loadBaselineContract(requiredOption(parsed, 'contract'));
  const common = { dbPath, apiDir, contract };
  if (!parsed.flags.has('apply')) {
    const assessment = await assessBaseline(common);
    return {
      ok: assessment.ok,
      label: 'baseline',
      payload: { kind: 'baseline', applied: false, assessment: baselineAssessmentJson(assessment) },
    };
  }
  const result = await applyBaseline({ ...common, writeMode: optionalWriteMode(parsed) });
  return {
    ok: result.assessment.ok,
    label: 'baseline',
    payload: { kind: 'baseline', applied: result.changed, assessment: baselineAssessmentJson(result.assessment) },
  };
}

async function runMap(parsed: ParsedArgs): Promise<CommandResult> {
  const dbPath = requiredOption(parsed, 'db');
  const output = requiredOption(parsed, 'output');
  const evidencePath = parsed.values.get('runtime-evidence');
  const common = {
    dbPath,
    mapTable: parsed.values.get('map-table'),
    targetMigration: parsed.values.get('target-migration'),
    runtimeEvidence: evidencePath === undefined ? undefined : await loadRuntimeEvidence(evidencePath),
  };
  const result = parsed.flags.has('apply-map')
    ? await applyLegacyMigrationMap({ ...common, writeMode: optionalWriteMode(parsed) })
    : { report: await buildLegacyMigrationMap(common), changed: false };
  const reportJson = legacyMapReportJson(result.report);
  await writeReportAtomically(output, reportJson);
  return {
    ok: result.report.ok,
    label: 'map',
    payload: { kind: 'map', applied: result.changed, report: reportJson },
  };
}

async function runInvariants(parsed: ParsedArgs): Promise<CommandResult> {
  const phase = requiredOption(parsed, 'phase');
  if (phase !== 'legacy' && phase !== 'final') throw new CliUsageError('--phase must be legacy or final');
  const report = await checkMigrationInvariants({
    dbPath: requiredOption(parsed, 'db'),
    phase,
    baselineCounts: await baselineCountsArgument(requiredOption(parsed, 'baseline-counts')),
  });
  return { ok: report.ok, label: 'invariants', payload: { kind: 'invariants', report: invariantReportJson(report) } };
}

async function dispatch(parsed: ParsedArgs): Promise<CommandResult> {
  switch (parsed.command) {
    case 'fingerprint': return runFingerprint(parsed);
    case 'baseline': return runBaseline(parsed);
    case 'map': return runMap(parsed);
    case 'invariants': return runInvariants(parsed);
    default: throw new CliUsageError(`Unknown command: ${parsed.command}\n${usage()}`);
  }
}

function humanResult(result: CommandResult): string {
  const status = result.ok ? 'OK' : 'BLOCKED';
  const payload = result.payload as Record<string, JsonValue>;
  const report = payload.report ?? payload.assessment;
  if (report !== null && typeof report === 'object' && !Array.isArray(report)) {
    const object = report as Record<string, JsonValue>;
    const blockers = object.blockers;
    if (Array.isArray(blockers)) return `[release-cli] ${result.label}: ${status} (${blockers.length} blocker(s))`;
  }
  return `[release-cli] ${result.label}: ${status}`;
}

function usage(): string {
  return [
    'Usage:',
    '  release-cli fingerprint --db <sqlite> [--json]',
    '  release-cli baseline --db <sqlite> --api-dir <api> --contract <json> [--apply --write-mode clone|live] [--json]',
    '  release-cli map --db <sqlite> --output <report.json> [--map-table <name>] [--runtime-evidence <json>] [--apply-map --write-mode clone|live] [--json]',
    '  release-cli invariants --db <sqlite> --phase legacy|final --baseline-counts <json-or-file> [--json]',
  ].join('\n');
}

/** Exported for node:test and the updater integration. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArgs | undefined;
  try {
    parsed = parseArguments(argv);
    const result = await dispatch(parsed);
    if (parsed.flags.has('json')) process.stdout.write(`${stableJson(sortJson(result.payload))}\n`);
    else process.stdout.write(`${humanResult(result)}\n`);
    return result.ok ? 0 : 3;
  } catch (error) {
    const message = error instanceof CliUsageError ? error.message : safeErrorMessage(error);
    const payload: JsonObject = { ok: false, kind: 'release-cli-error', error: { message } };
    if (parsed?.flags.has('json') === true) process.stdout.write(`${stableJson(payload)}\n`);
    else process.stderr.write(`[release-cli] ${message}\n`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`[release-cli] ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
