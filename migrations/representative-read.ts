#!/usr/bin/env node
import {
  parseHookArguments,
  requiredAbsolutePath,
} from './hooks/cli';
import { fetchReleaseHealth } from './hooks/release-health';
import { safeErrorMessage } from './release/redaction';
import {
  columnNumber,
  querySqliteJson,
  runSqlite,
} from './release/sqlite';

interface DatabaseCounts {
  readonly sites: number;
  readonly siteDomains: number;
}

async function databaseCounts(database: string): Promise<DatabaseCounts> {
  const integrity = (await runSqlite(database, 'PRAGMA quick_check;', { readOnly: true, timeoutMs: 60_000 })).trim();
  if (integrity !== 'ok') throw new Error('SQLite quick_check did not pass');
  const rows = await querySqliteJson(database, `
    SELECT
      (SELECT COUNT(*) FROM sites) AS sites,
      (SELECT COUNT(*) FROM site_domains) AS site_domains;
  `);
  const sites = rows[0] ? columnNumber(rows[0], 'sites') : null;
  const siteDomains = rows[0] ? columnNumber(rows[0], 'site_domains') : null;
  if (
    sites === null
    || siteDomains === null
    || !Number.isInteger(sites)
    || !Number.isInteger(siteDomains)
    || sites < 0
    || siteDomains < 0
  ) {
    throw new Error('SQLite representative counts are invalid');
  }
  return { sites, siteDomains };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const arguments_ = parseHookArguments(argv, true);
    if (arguments_.command !== 'check' && arguments_.command !== 'verify') {
      throw new Error('representative read command must be check or verify');
    }
    requiredAbsolutePath(arguments_, 'release-dir');
    const database = requiredAbsolutePath(arguments_, 'database');
    const counts = await databaseCounts(database);
    if (arguments_.command === 'verify') {
      const health = await fetchReleaseHealth(database);
      if (
        health.counts.sites !== counts.sites
        || health.counts.siteDomains !== counts.siteDomains
        || health.counts.activeOperations !== 0
      ) {
        throw new Error('candidate API representative read does not match SQLite state');
      }
    }
    process.stdout.write(`[representative-read] ${arguments_.command} passed\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[representative-read] ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
