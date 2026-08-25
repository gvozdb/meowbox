import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { resolveFederationHost } from './endpoint-normalizer';
import { federationKeyIdFromPublicKeySpki } from './federation-key-material';

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_BOOTSTRAP_ARTIFACT_BYTES = 256 * 1024;
const TARGET_CLI = 'dist/federation/federation-enrollment-bootstrap.cli.js';
const RELEASE_ROOT = '/opt/meowbox/current/api';
const LEGACY_ROOT = '/opt/meowbox/api';

export type FederationSshErrorCode =
  | 'SSH_ADDRESS_BLOCKED'
  | 'SSH_CONNECT_FAILED'
  | 'SSH_FINGERPRINT_MISMATCH'
  | 'SSH_TARGET_DEV_MODE'
  | 'SSH_PROTOCOL_UNAVAILABLE'
  | 'SSH_INSTALL_FAILED'
  | 'SSH_RELOAD_FAILED'
  | 'SSH_BOOTSTRAP_FAILED'
  | 'SSH_RESPONSE_INVALID';

export class FederationSshError extends Error {
  constructor(readonly code: FederationSshErrorCode) {
    super(code);
    this.name = 'FederationSshError';
  }
}

export interface FederationSshBootstrapInput {
  enrollmentId: string;
  requestedDisplayName: string;
  sshHost: string;
  sshPort: number;
  sshPassword: string;
  sshFingerprint: string;
  proof: Buffer;
  expiresAt: Date;
  apiOrigin: string;
  wsOrigin: string;
  wsPath: string;
  browserPublicOrigin: string;
  directTransferOrigin: string;
}

export type FederationSshRuntimeInput = Pick<
  FederationSshBootstrapInput,
  'enrollmentId' | 'sshHost' | 'sshPort' | 'sshPassword' | 'sshFingerprint'
>;

export interface FederationSshBootstrapResult {
  enrollmentId: string;
  targetInstallationId: string;
  manifestKid: string;
  manifestPublicKeySpki: string;
}

interface BootstrapCliResponse {
  schemaVersion: 1;
  enrollment: { id: string; state: string; expiresAt: string };
  target: {
    installationId: string;
    installationRole: 'TARGET';
    manifestKid: string;
    manifestPublicKeySpki: string;
    configurationChanged: boolean;
  };
}

export function sshFingerprintFromHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function validateCliResponse(raw: string, input: FederationSshBootstrapInput): BootstrapCliResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new FederationSshError('SSH_RESPONSE_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FederationSshError('SSH_RESPONSE_INVALID');
  }
  const response = value as BootstrapCliResponse;
  try {
    if (
      response.schemaVersion !== 1 ||
      response.enrollment?.id !== input.enrollmentId ||
      !CANONICAL_UUID.test(response.enrollment?.id || '') ||
      !['SSH_VERIFIED', 'MANIFEST_PENDING'].includes(response.enrollment?.state) ||
      response.enrollment?.expiresAt !== input.expiresAt.toISOString() ||
      response.target?.installationRole !== 'TARGET' ||
      typeof response.target?.configurationChanged !== 'boolean' ||
      !CANONICAL_UUID.test(response.target?.installationId || '') ||
      federationKeyIdFromPublicKeySpki(response.target?.manifestPublicKeySpki || '') !==
        response.target?.manifestKid
    ) throw new Error('invalid');
  } catch {
    throw new FederationSshError('SSH_RESPONSE_INVALID');
  }
  return response;
}

export function federationRuntimeProbeCommand(): string {
  return [
    'if test -e /opt/meowbox/.dev-mode; then printf dev-mode;',
    `elif test -f ${RELEASE_ROOT}/${TARGET_CLI} && test -f /opt/meowbox/state/.env; then printf release;`,
    `elif test -f ${LEGACY_ROOT}/${TARGET_CLI} && test -f /opt/meowbox/.env; then printf legacy;`,
    'else printf missing; fi',
  ].join(' ');
}

export function federationBootstrapCommand(remotePath: string): string {
  if (!/^\/tmp\/meowbox-federation-enrollment-[0-9a-f-]{36}\.json$/.test(remotePath)) {
    throw new Error('Federation enrollment request path is invalid');
  }
  return [
    `if test -f ${RELEASE_ROOT}/${TARGET_CLI} && test -f /opt/meowbox/state/.env; then`,
    `cd ${RELEASE_ROOT} && MEOWBOX_STATE_DIR=/opt/meowbox/state node --env-file=/opt/meowbox/state/.env ${TARGET_CLI} --request-file=${remotePath};`,
    `elif test -f ${LEGACY_ROOT}/${TARGET_CLI} && test -f /opt/meowbox/.env; then`,
    `cd ${LEGACY_ROOT} && MEOWBOX_DATA_DIR=/opt/meowbox/data node --env-file=/opt/meowbox/.env ${TARGET_CLI} --request-file=${remotePath};`,
    'else exit 42; fi',
  ].join(' ');
}

export function federationInstallCommand(remotePath: string, version: string): string {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
    throw new Error('Provisioning release version is invalid');
  }
  if (!/^\/tmp\/meowbox-federation-bootstrap-[0-9a-f-]{36}\.sh$/.test(remotePath)) {
    throw new Error('Provisioning bootstrap path is invalid');
  }
  return `MEOWBOX_VERSION=${version} bash -- ${remotePath} --installation-role target`;
}

async function readProvisioningArtifact(): Promise<Readonly<{ script: Buffer; version: string }>> {
  const root = path.resolve(process.cwd(), '..');
  const [script, rawVersion] = await Promise.all([
    readFile(path.join(root, 'bootstrap.sh')),
    readFile(path.join(root, 'VERSION'), 'utf8'),
  ]);
  const version = rawVersion.trim();
  if (
    script.length < 128 ||
    script.length > MAX_BOOTSTRAP_ARTIFACT_BYTES ||
    !script.subarray(0, 20).toString('utf8').startsWith('#!/usr/bin/env bash')
  ) throw new Error('Provisioning bootstrap artifact is invalid');
  federationInstallCommand('/tmp/meowbox-federation-bootstrap-00000000-0000-4000-8000-000000000000.sh', version);
  return { script, version };
}

function assertRuntimeState(value: string): 'release' | 'legacy' | 'missing' {
  if (value === 'dev-mode') throw new FederationSshError('SSH_TARGET_DEV_MODE');
  if (value !== 'release' && value !== 'legacy' && value !== 'missing') {
    throw new FederationSshError('SSH_BOOTSTRAP_FAILED');
  }
  return value;
}

@Injectable()
export class FederationEnrollmentSshService {
  async ensureTargetRuntime(input: FederationSshRuntimeInput): Promise<Readonly<{ installed: boolean }>> {
    this.assertConnectionInput(input);
    const selectedAddress = await this.resolveAddress(input.sshHost);
    const connection = await this.connect({ ...input, selectedAddress });
    let sftp: SFTPWrapper | null = null;
    const remotePath = `/tmp/meowbox-federation-bootstrap-${input.enrollmentId}.sh`;
    try {
      const initial = assertRuntimeState(
        (await this.exec(connection, federationRuntimeProbeCommand())).trim(),
      );
      if (initial !== 'missing') return { installed: false };
      const artifact = await readProvisioningArtifact().catch(() => {
        throw new FederationSshError('SSH_INSTALL_FAILED');
      });
      sftp = await this.openSftp(connection);
      await this.writeFile(sftp, remotePath, artifact.script, 0o700);
      try {
        await this.exec(
          connection,
          federationInstallCommand(remotePath, artifact.version),
          15 * 60_000,
          false,
        );
      } catch {
        throw new FederationSshError('SSH_INSTALL_FAILED');
      }
      const installed = assertRuntimeState(
        (await this.exec(connection, federationRuntimeProbeCommand())).trim(),
      );
      if (installed === 'missing') throw new FederationSshError('SSH_PROTOCOL_UNAVAILABLE');
      return { installed: true };
    } finally {
      if (sftp) await this.unlinkIfPresent(sftp, remotePath);
      connection.end();
    }
  }

  async prepareTargetBootstrap(
    input: FederationSshBootstrapInput,
  ): Promise<FederationSshBootstrapResult> {
    this.assertConnectionInput(input);
    if (
      input.proof.length !== 32 ||
      [input.apiOrigin, input.wsOrigin, input.wsPath, input.browserPublicOrigin,
        input.directTransferOrigin].some((value) => typeof value !== 'string' || value.length > 512)
    ) throw new FederationSshError('SSH_BOOTSTRAP_FAILED');
    const selectedAddress = await this.resolveAddress(input.sshHost);
    const connection = await this.connect({ ...input, selectedAddress });
    const remotePath = `/tmp/meowbox-federation-enrollment-${input.enrollmentId}.json`;
    let sftp: SFTPWrapper | null = null;
    try {
      sftp = await this.openSftp(connection);
      const runtime = assertRuntimeState(
        (await this.exec(connection, federationRuntimeProbeCommand())).trim(),
      );
      if (runtime === 'missing') throw new FederationSshError('SSH_PROTOCOL_UNAVAILABLE');
      const request = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        enrollmentId: input.enrollmentId,
        requestedDisplayName: input.requestedDisplayName,
        sshHost: input.sshHost,
        sshPort: input.sshPort,
        sshFingerprint: input.sshFingerprint,
        proof: input.proof.toString('base64url'),
        expiresAt: input.expiresAt.toISOString(),
        apiOrigin: input.apiOrigin,
        wsOrigin: input.wsOrigin,
        wsPath: input.wsPath,
        browserPublicOrigin: input.browserPublicOrigin,
        directTransferOrigin: input.directTransferOrigin,
      }), 'utf8');
      await this.writeFile(sftp, remotePath, request);
      const output = await this.exec(connection, federationBootstrapCommand(remotePath));
      const response = validateCliResponse(output, input);
      try {
        // Always reload: a previous attempt may have persisted the target role
        // and then lost the SSH acknowledgement before reloading PM2.
        await this.exec(connection, 'pm2 reload meowbox-api --update-env', 30_000, false);
      } catch {
        throw new FederationSshError('SSH_RELOAD_FAILED');
      }
      return {
        enrollmentId: response.enrollment.id,
        targetInstallationId: response.target.installationId,
        manifestKid: response.target.manifestKid,
        manifestPublicKeySpki: response.target.manifestPublicKeySpki,
      };
    } finally {
      if (sftp) await this.unlinkIfPresent(sftp, remotePath);
      connection.end();
    }
  }

  private assertConnectionInput(input: FederationSshRuntimeInput): void {
    if (
      !CANONICAL_UUID.test(input.enrollmentId) ||
      typeof input.sshHost !== 'string' ||
      input.sshHost.length === 0 ||
      input.sshHost.length > 253 ||
      !Number.isInteger(input.sshPort) ||
      input.sshPort < 1 ||
      input.sshPort > 65535 ||
      input.sshPassword.length === 0 ||
      input.sshPassword.length > 256 ||
      !/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.sshFingerprint)
    ) throw new FederationSshError('SSH_BOOTSTRAP_FAILED');
  }

  private async resolveAddress(host: string): Promise<string> {
    try {
      return (await resolveFederationHost(host)).selectedAddress;
    } catch {
      throw new FederationSshError('SSH_ADDRESS_BLOCKED');
    }
  }

  private async connect(
    input: FederationSshRuntimeInput & { selectedAddress: string },
  ): Promise<Client> {
    let fingerprintMismatch = false;
    return new Promise((resolve, reject) => {
      const connection = new Client();
      connection.once('ready', () => resolve(connection));
      connection.once('error', () => reject(new FederationSshError(
        fingerprintMismatch ? 'SSH_FINGERPRINT_MISMATCH' : 'SSH_CONNECT_FAILED',
      )));
      connection.connect({
        host: input.selectedAddress,
        port: input.sshPort,
        username: 'root',
        password: input.sshPassword,
        readyTimeout: 15_000,
        keepaliveInterval: 5_000,
        keepaliveCountMax: 2,
        hostVerifier: (key: Buffer | string) => {
          const actual = sshFingerprintFromHostKey(
            Buffer.isBuffer(key) ? key : Buffer.from(key, 'binary'),
          );
          fingerprintMismatch = actual !== input.sshFingerprint;
          return !fingerprintMismatch;
        },
      });
    });
  }

  private openSftp(connection: Client): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      connection.sftp((error, sftp) => {
        if (error) reject(new FederationSshError('SSH_BOOTSTRAP_FAILED'));
        else resolve(sftp);
      });
    });
  }

  private writeFile(
    sftp: SFTPWrapper,
    remotePath: string,
    content: Buffer,
    mode: 0o600 | 0o700 = 0o600,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, content, { mode }, (error) => {
        if (error) reject(new FederationSshError('SSH_BOOTSTRAP_FAILED'));
        else sftp.chmod(remotePath, mode, (chmodError) => {
          if (chmodError) reject(new FederationSshError('SSH_BOOTSTRAP_FAILED'));
          else resolve();
        });
      });
    });
  }

  private exec(
    connection: Client,
    command: string,
    timeoutMs = 30_000,
    captureOutput = true,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let commandStream: ClientChannel | null = null;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const succeed = (value: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        commandStream?.close();
        fail(new FederationSshError('SSH_BOOTSTRAP_FAILED'));
      }, timeoutMs);
      connection.exec(command, (error, stream) => {
        if (error) {
          fail(new FederationSshError('SSH_BOOTSTRAP_FAILED'));
          return;
        }
        commandStream = stream;
        this.collectCommand(stream, succeed, fail, captureOutput);
      });
    });
  }

  private collectCommand(
    stream: ClientChannel,
    resolve: (value: string) => void,
    reject: (error: Error) => void,
    captureOutput: boolean,
  ): void {
    const stdout: Buffer[] = [];
    let size = 0;
    let failed = false;
    const consume = (chunk: Buffer) => {
      if (!captureOutput) return;
      size += chunk.length;
      if (size > MAX_COMMAND_OUTPUT_BYTES) {
        failed = true;
        stream.close();
      } else {
        stdout.push(chunk);
      }
    };
    stream.on('data', consume);
    stream.stderr.on('data', (chunk: Buffer) => {
      if (!captureOutput) return;
      size += chunk.length;
      if (size > MAX_COMMAND_OUTPUT_BYTES) {
        failed = true;
        stream.close();
      }
    });
    stream.once('close', (code: number) => {
      if (failed || code !== 0) {
        reject(new FederationSshError(
          code === 42 ? 'SSH_PROTOCOL_UNAVAILABLE' : 'SSH_BOOTSTRAP_FAILED',
        ));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8').trim());
    });
  }

  private unlinkIfPresent(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    return new Promise((resolve) => {
      sftp.unlink(remotePath, () => resolve());
    });
  }
}
