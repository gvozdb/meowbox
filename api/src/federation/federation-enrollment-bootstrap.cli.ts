import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { PrismaService } from '../common/prisma.service';
import { FederationActionCatalogueService } from './federation-action-catalogue.service';
import { decodeEnrollmentProof } from './federation-enrollment-bootstrap';
import { FederationEnrollmentService } from './federation-enrollment.service';
import { PanelIdentityService } from './panel-identity.service';
import { prepareFederationTargetConfiguration } from './federation-target-bootstrap-config';

const REQUEST_PATH = /^\/tmp\/meowbox-federation-enrollment-[0-9a-f-]{36}\.json$/;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_KEYS = [
  'expiresAt',
  'apiOrigin',
  'browserPublicOrigin',
  'directTransferOrigin',
  'enrollmentId',
  'proof',
  'requestedDisplayName',
  'schemaVersion',
  'sshFingerprint',
  'sshHost',
  'sshPort',
  'wsOrigin',
  'wsPath',
] as const;

interface BootstrapRequest {
  schemaVersion: 1;
  enrollmentId: string;
  requestedDisplayName: string;
  apiOrigin: string;
  wsOrigin: string;
  wsPath: string;
  browserPublicOrigin: string;
  directTransferOrigin: string;
  sshHost: string;
  sshPort: number;
  sshFingerprint: string;
  proof: string;
  expiresAt: string;
}

function parseRequestPath(): string {
  const [argument, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || !argument?.startsWith('--request-file=')) {
    throw new Error('bootstrap request argument is invalid');
  }
  const requestPath = argument.slice('--request-file='.length);
  if (!REQUEST_PATH.test(requestPath)) {
    throw new Error('bootstrap request path is invalid');
  }
  return requestPath;
}

function parseRequest(value: string): BootstrapRequest {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('bootstrap request is invalid');
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('\0') !== [...REQUEST_KEYS].sort().join('\0') ||
    record.schemaVersion !== 1 ||
    typeof record.enrollmentId !== 'string' ||
    !CANONICAL_UUID.test(record.enrollmentId) ||
    typeof record.requestedDisplayName !== 'string' ||
    typeof record.apiOrigin !== 'string' ||
    typeof record.wsOrigin !== 'string' ||
    typeof record.wsPath !== 'string' ||
    typeof record.browserPublicOrigin !== 'string' ||
    typeof record.directTransferOrigin !== 'string' ||
    typeof record.sshHost !== 'string' ||
    !Number.isInteger(record.sshPort) ||
    typeof record.sshFingerprint !== 'string' ||
    typeof record.proof !== 'string' ||
    typeof record.expiresAt !== 'string'
  ) throw new Error('bootstrap request is invalid');
  return record as unknown as BootstrapRequest;
}

async function consumeRequestFile(requestPath: string): Promise<BootstrapRequest> {
  const handle = await open(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 2 ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    ) throw new Error('bootstrap request file is unsafe');
    await unlink(requestPath);
    return parseRequest(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const requestPath = parseRequestPath();
  const request = await consumeRequestFile(requestPath);
  if (requestPath !== `/tmp/meowbox-federation-enrollment-${request.enrollmentId}.json`) {
    throw new Error('bootstrap enrollment binding is invalid');
  }
  const expiresAt = new Date(request.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== request.expiresAt) {
    throw new Error('bootstrap expiry is invalid');
  }

  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const config = new ConfigService();
    const configuration = await prepareFederationTargetConfiguration(prisma, config, {
      apiOrigin: request.apiOrigin,
      wsOrigin: request.wsOrigin,
      wsPath: request.wsPath,
      browserPublicOrigin: request.browserPublicOrigin,
      directTransferOrigin: request.directTransferOrigin,
    });
    const identity = new PanelIdentityService(prisma, config);
    const enrollment = new FederationEnrollmentService(
      prisma,
      identity,
      new FederationActionCatalogueService(),
    );
    const prepared = await enrollment.prepareTargetBootstrap({
      enrollmentId: request.enrollmentId,
      requestedDisplayName: request.requestedDisplayName,
      sshHost: request.sshHost,
      sshPort: request.sshPort,
      sshFingerprint: request.sshFingerprint,
      proof: decodeEnrollmentProof(request.proof),
      expiresAt,
    });
    const local = await identity.getLocalIdentity();
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      enrollment: prepared,
      target: {
        installationId: local.installationId,
        installationRole: local.installationRole,
        manifestKid: local.manifestKid,
        manifestPublicKeySpki: local.manifestPublicKeySpki,
        configurationChanged: configuration.changed,
      },
    })}\n`);
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch(() => {
  process.stderr.write('FEDERATION_BOOTSTRAP_FAILED\n');
  process.exitCode = 1;
});
