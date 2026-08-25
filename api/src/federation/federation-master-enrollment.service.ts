import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FederationEnrollment, Prisma } from '@prisma/client';
import {
  canonicalFederationJson,
  SignedFederationManifest,
} from '@meowbox/shared';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CreateFederationEnrollmentDto } from './federation-master-enrollment.dto';
import {
  evaluateFederationManifest,
  FederationManifestEvaluation,
} from './federation-compatibility.service';
import { FederationActionCatalogueService } from './federation-action-catalogue.service';
import { enrollmentProofHash } from './federation-enrollment-bootstrap';
import {
  openEnrollmentProof,
  sealEnrollmentProof,
} from './federation-enrollment-secret';
import { FederationEnrollmentHttpService } from './federation-enrollment-http.service';
import {
  FederationEnrollmentSshService,
  FederationSshBootstrapResult,
  FederationSshError,
} from './federation-enrollment-ssh.service';
import {
  generateFederationRelationshipKey,
  federationKeyIdFromPublicKeySpki,
} from './federation-key-material';
import { validateFederationSocketPath } from './federation-local-endpoint.service';
import {
  parseFederationOrigin,
  resolveFederationHost,
  resolveFederationOrigin,
} from './endpoint-normalizer';
import { FederationManifestVerifierService } from './federation-manifest-verifier.service';
import { validateFederationSpkiPin } from './pinned-dispatcher';
import { PanelIdentityService } from './panel-identity.service';
import { RemoteRegistryService } from './remote-registry.service';

const BOOTSTRAP_TTL_MS = 9 * 60_000;
const RESUME_LEASE_MS = 20 * 60_000;

interface EnrollmentCandidate {
  schemaVersion: 1;
  apiOrigin: string;
  wsOrigin: string;
  wsPath: string;
  browserPublicOrigin: string;
  directTransferOrigin: string;
  spkiSha256: string;
  maxRole: 'ADMIN' | 'MANAGER';
  normalizedHash: string;
}

export interface MasterEnrollmentView {
  id: string;
  displayName: string;
  state: string;
  inProgress: boolean;
  reasonCode: string | null;
  attemptCount: number;
  targetInstallationId: string | null;
  remoteServerId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function candidateHash(candidate: Omit<EnrollmentCandidate, 'normalizedHash'>): string {
  return createHash('sha256')
    .update(canonicalFederationJson(candidate))
    .digest('hex');
}

function parseCandidate(raw: string | null): EnrollmentCandidate {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    throw new ConflictException('Enrollment candidate is corrupt');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictException('Enrollment candidate is corrupt');
  }
  const candidate = value as EnrollmentCandidate;
  const expectedKeys = [
    'apiOrigin',
    'browserPublicOrigin',
    'directTransferOrigin',
    'maxRole',
    'normalizedHash',
    'schemaVersion',
    'spkiSha256',
    'wsOrigin',
    'wsPath',
  ].sort();
  if (
    Object.keys(candidate).sort().join('\0') !== expectedKeys.join('\0') ||
    candidate.schemaVersion !== 1 ||
    !['ADMIN', 'MANAGER'].includes(candidate.maxRole)
  ) throw new ConflictException('Enrollment candidate is corrupt');
  try {
    parseFederationOrigin(candidate.apiOrigin);
    parseFederationOrigin(candidate.wsOrigin);
    parseFederationOrigin(candidate.browserPublicOrigin);
    parseFederationOrigin(candidate.directTransferOrigin);
    validateFederationSocketPath(candidate.wsPath);
    validateFederationSpkiPin(candidate.spkiSha256);
  } catch {
    throw new ConflictException('Enrollment candidate is corrupt');
  }
  const { normalizedHash, ...basis } = candidate;
  if (candidateHash(basis) !== normalizedHash) {
    throw new ConflictException('Enrollment candidate binding mismatch');
  }
  return candidate;
}

function enrollmentView(row: {
  id: string;
  requestedDisplayName: string;
  state: string;
  leaseUntil: Date | null;
  sanitizedErrorCode: string | null;
  attemptCount: number;
  targetInstallationId: string | null;
  remoteServerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}, now = new Date()): MasterEnrollmentView {
  return {
    id: row.id,
    displayName: row.requestedDisplayName,
    state: row.state,
    inProgress: !!row.leaseUntil && row.leaseUntil.getTime() > now.getTime(),
    reasonCode: row.sanitizedErrorCode,
    attemptCount: row.attemptCount,
    targetInstallationId: row.targetInstallationId,
    remoteServerId: row.remoteServerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function sanitizedFailureCode(error: unknown): string {
  if (error instanceof FederationSshError) return error.code;
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    /^[A-Z][A-Z0-9_]{2,63}$/.test((error as { code: string }).code)
  ) return (error as { code: string }).code;
  if (error instanceof ConflictException) return 'ENROLLMENT_STATE_CONFLICT';
  return 'ENROLLMENT_STEP_FAILED';
}

@Injectable()
export class FederationMasterEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly catalogue: FederationActionCatalogueService,
    private readonly ssh: FederationEnrollmentSshService,
    private readonly http: FederationEnrollmentHttpService,
    private readonly manifestVerifier: FederationManifestVerifierService,
    private readonly registry: RemoteRegistryService,
  ) {}

  async create(
    input: CreateFederationEnrollmentDto,
    requestedByUserId: string,
    now = new Date(),
  ): Promise<MasterEnrollmentView> {
    await this.registry.assertControlPlane();
    if (await this.registry.authority() !== 'DB') {
      throw new ConflictException('DB registry cutover is required before enrollment');
    }
    const candidate = await this.validateCandidate(input);
    const displayName = input.displayName.trim();
    const duplicate = await this.prisma.federationEnrollment.findFirst({
      where: {
        enrollmentRole: 'CONTROL_PLANE',
        requestedDisplayName: displayName,
        state: { notIn: ['CANCELLED', 'COMPLETED'] },
      },
      select: { id: true },
    });
    if (duplicate || await this.prisma.remoteServer.findUnique({
      where: { displayName },
      select: { id: true },
    })) throw new ConflictException('Server name is already enrolled or pending');

    const id = randomUUID();
    const proof = randomBytes(32);
    const created = await this.prisma.federationEnrollment.create({
      data: {
        id,
        enrollmentRole: 'CONTROL_PLANE',
        requestedByUserId,
        requestedDisplayName: displayName,
        state: 'MASTER_PREPARED',
        sshHost: input.sshHost.toLowerCase(),
        sshPort: input.sshPort ?? 22,
        sshFingerprint: input.sshFingerprint,
        bootstrapHash: enrollmentProofHash(proof),
        bootstrapSecretEnc: sealEnrollmentProof(id, proof),
        candidateEndpointJson: JSON.stringify(candidate),
        expiresAt: new Date(now.getTime() + BOOTSTRAP_TTL_MS),
      },
    });
    return enrollmentView(created, now);
  }

  async list(): Promise<MasterEnrollmentView[]> {
    await this.registry.assertControlPlane();
    const rows = await this.prisma.federationEnrollment.findMany({
      where: { enrollmentRole: 'CONTROL_PLANE' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => enrollmentView(row));
  }

  async get(id: string): Promise<MasterEnrollmentView> {
    await this.registry.assertControlPlane();
    return enrollmentView(await this.findMasterEnrollment(id));
  }

  async resume(
    id: string,
    sshPassword: string,
    now = new Date(),
  ): Promise<MasterEnrollmentView> {
    await this.registry.assertControlPlane();
    const initial = await this.findMasterEnrollment(id);
    if (initial.state === 'COMPLETED') return enrollmentView(initial, now);
    if (initial.state === 'CANCELLED') {
      throw new ConflictException('Cancelled enrollment cannot be resumed');
    }
    const leaseUntil = new Date(now.getTime() + RESUME_LEASE_MS);
    const claimed = await this.prisma.federationEnrollment.updateMany({
      where: {
        id,
        enrollmentRole: 'CONTROL_PLANE',
        state: { notIn: ['COMPLETED', 'CANCELLED'] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: {
        leaseUntil,
        lastAttemptAt: now,
        attemptCount: { increment: 1 },
        sanitizedErrorCode: null,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('Enrollment is already being resumed');
    }

    try {
      const claimedEnrollment = await this.findMasterEnrollment(id);
      const candidate = parseCandidate(claimedEnrollment.candidateEndpointJson);
      await this.ssh.ensureTargetRuntime({
        enrollmentId: id,
        sshHost: claimedEnrollment.sshHost,
        sshPort: claimedEnrollment.sshPort,
        sshPassword,
        sshFingerprint: claimedEnrollment.sshFingerprint,
      });
      const prepared = await this.rotateProof(
        await this.findMasterEnrollment(id),
        new Date(),
      );
      const proof = openEnrollmentProof(id, prepared.bootstrapSecretEnc!);
      const target = await this.ssh.prepareTargetBootstrap({
        enrollmentId: id,
        requestedDisplayName: prepared.requestedDisplayName,
        sshHost: prepared.sshHost,
        sshPort: prepared.sshPort,
        sshPassword,
        sshFingerprint: prepared.sshFingerprint,
        proof,
        expiresAt: prepared.expiresAt,
        apiOrigin: candidate.apiOrigin,
        wsOrigin: candidate.wsOrigin,
        wsPath: candidate.wsPath,
        browserPublicOrigin: candidate.browserPublicOrigin,
        directTransferOrigin: candidate.directTransferOrigin,
      });
      const trust = await this.ensurePendingMasterTrust(prepared, target, candidate, now);
      const localIdentity = await this.panelIdentity.getLocalIdentity();
      const exchange = await this.http.exchangeTrust({
        apiOrigin: candidate.apiOrigin,
        spkiSha256: candidate.spkiSha256,
        proof,
        establish: {
          issuerInstallationId: localIdentity.installationId,
          keyId: trust.key.kid,
          publicKeySpki: trust.key.publicKeySpki,
          maxRole: candidate.maxRole,
          permissions: trust.permissions,
          principalVersion: 1,
          sshFingerprint: prepared.sshFingerprint,
        },
      });
      this.assertTrustResponse(id, target, exchange.trust);
      await this.prisma.federationEnrollment.update({
        where: { id },
        data: { state: 'MASTER_TRUST_ESTABLISHED' },
      });

      const manifest = this.manifestVerifier.verify({
        manifest: exchange.manifest,
        targetInstallationId: target.targetInstallationId,
        manifestKid: target.manifestKid,
        manifestPublicKeySpki: target.manifestPublicKeySpki,
        now,
      });
      const evaluation = this.evaluateCandidateManifest(manifest, candidate);
      await this.prisma.federationEnrollment.update({
        where: { id },
        data: { state: 'MANIFEST_VERIFIED' },
      });
      await this.registry.commitFederatedEnrollment({
        enrollmentId: id,
        issuerId: trust.issuerId,
        displayName: prepared.requestedDisplayName,
        targetInstallationId: target.targetInstallationId,
        targetManifestKid: target.manifestKid,
        targetManifestPublicKeySpki: target.manifestPublicKeySpki,
        endpoint: {
          apiOrigin: candidate.apiOrigin,
          wsOrigin: candidate.wsOrigin,
          wsPath: candidate.wsPath,
          browserPublicOrigin: candidate.browserPublicOrigin,
          directTransferOrigin: candidate.directTransferOrigin,
          sshHost: prepared.sshHost,
          sshPort: prepared.sshPort,
          spkiSha256: candidate.spkiSha256,
          normalizedHash: candidate.normalizedHash,
        },
        manifest,
        evaluation,
        now,
      });
      await this.http.complete({
        apiOrigin: candidate.apiOrigin,
        spkiSha256: candidate.spkiSha256,
        proof,
        enrollmentId: id,
      });
      return enrollmentView(await this.findMasterEnrollment(id), now);
    } catch (error) {
      await this.prisma.federationEnrollment.updateMany({
        where: { id, enrollmentRole: 'CONTROL_PLANE', leaseUntil },
        data: {
          leaseUntil: null,
          sanitizedErrorCode: sanitizedFailureCode(error),
        },
      });
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) throw error;
      throw new ServiceUnavailableException('Federation enrollment step failed', {
        cause: error,
      });
    } finally {
      await this.prisma.federationEnrollment.updateMany({
        where: { id, enrollmentRole: 'CONTROL_PLANE', leaseUntil },
        data: { leaseUntil: null },
      });
    }
  }

  async cancel(id: string, now = new Date()): Promise<MasterEnrollmentView> {
    await this.registry.assertControlPlane();
    const enrollment = await this.findMasterEnrollment(id);
    if (enrollment.state === 'COMPLETED' || enrollment.remoteServerId) {
      throw new ConflictException('Enrolled server requires federation revocation lifecycle');
    }
    if (enrollment.leaseUntil && enrollment.leaseUntil.getTime() > now.getTime()) {
      throw new ConflictException('Enrollment is currently running');
    }
    await this.prisma.$transaction(async (tx) => {
      if (enrollment.delegationIssuerId) {
        await tx.federationKey.updateMany({
          where: { issuerId: enrollment.delegationIssuerId, revokedAt: null },
          data: { state: 'REVOKED', revokedAt: now },
        });
        await tx.federationIssuer.updateMany({
          where: { id: enrollment.delegationIssuerId, revokedAt: null },
          data: { state: 'REVOKED', revokedAt: now },
        });
      }
      await tx.federationEnrollment.update({
        where: { id },
        data: {
          state: 'CANCELLED',
          bootstrapSecretEnc: null,
          leaseUntil: null,
          sanitizedErrorCode: null,
          expiresAt: now,
          completedAt: now,
        },
      });
    });
    return enrollmentView(await this.findMasterEnrollment(id), now);
  }

  private async validateCandidate(
    input: CreateFederationEnrollmentDto,
  ): Promise<EnrollmentCandidate> {
    try {
      const api = parseFederationOrigin(input.apiOrigin);
      const ws = parseFederationOrigin(input.wsOrigin);
      const browser = parseFederationOrigin(input.browserPublicOrigin);
      const transfer = parseFederationOrigin(input.directTransferOrigin);
      if (
        api.origin !== ws.origin ||
        api.origin !== browser.origin ||
        api.origin !== transfer.origin
      ) throw new Error('protocol 1 enrollment requires one public target origin');
      await Promise.all([
        resolveFederationOrigin(api),
        resolveFederationOrigin(ws),
        resolveFederationOrigin(browser),
        resolveFederationOrigin(transfer),
        resolveFederationHost(input.sshHost),
      ]);
      const basis = {
        schemaVersion: 1 as const,
        apiOrigin: api.origin,
        wsOrigin: ws.origin,
        wsPath: validateFederationSocketPath(input.wsPath?.trim() || '/socket.io'),
        browserPublicOrigin: browser.origin,
        directTransferOrigin: transfer.origin,
        spkiSha256: validateFederationSpkiPin(input.spkiSha256),
        maxRole: input.maxRole ?? 'ADMIN',
      };
      return { ...basis, normalizedHash: candidateHash(basis) };
    } catch (error) {
      throw new BadRequestException('Federation endpoint candidate is invalid', {
        cause: error,
      });
    }
  }

  private async findMasterEnrollment(id: string) {
    const enrollment = await this.prisma.federationEnrollment.findFirst({
      where: { id, enrollmentRole: 'CONTROL_PLANE' },
    });
    if (!enrollment) throw new NotFoundException('Federation enrollment not found');
    return enrollment;
  }

  private async rotateProof(
    enrollment: FederationEnrollment,
    now: Date,
  ): Promise<FederationEnrollment> {
    const proof = randomBytes(32);
    return this.prisma.federationEnrollment.update({
      where: { id: enrollment.id },
      data: {
        bootstrapHash: enrollmentProofHash(proof),
        bootstrapSecretEnc: sealEnrollmentProof(enrollment.id, proof),
        expiresAt: new Date(now.getTime() + BOOTSTRAP_TTL_MS),
      },
    });
  }

  private async ensurePendingMasterTrust(
    enrollment: FederationEnrollment,
    target: FederationSshBootstrapResult,
    candidate: EnrollmentCandidate,
    now: Date,
  ): Promise<Readonly<{
    issuerId: string;
    permissions: string[];
    key: { kid: string; publicKeySpki: string };
  }>> {
    if (
      target.targetInstallationId === (await this.panelIdentity.getLocalIdentity()).installationId ||
      federationKeyIdFromPublicKeySpki(target.manifestPublicKeySpki) !== target.manifestKid
    ) throw new ConflictException('Target identity is invalid');
    const permissions = [...new Set(
      this.catalogue.activeActions().flatMap((action) => action.authorization.permissions),
    )].sort();
    if (permissions.length === 0) {
      throw new ConflictException('No reviewed federation actions are available');
    }

    if (enrollment.delegationIssuerId) {
      const issuer = await this.prisma.federationIssuer.findUnique({
        where: { id: enrollment.delegationIssuerId },
        include: { keys: true },
      });
      const key = issuer?.keys.find((item) => item.state === 'PENDING');
      if (
        !issuer ||
        issuer.state !== 'PENDING' ||
        issuer.targetInstallationId !== target.targetInstallationId ||
        issuer.maxRole !== candidate.maxRole ||
        issuer.permissionPolicyJson !== JSON.stringify(permissions) ||
        !key ||
        !key.encryptedPrivateKey ||
        enrollment.targetManifestKid !== target.manifestKid ||
        enrollment.targetManifestKeySpki !== target.manifestPublicKeySpki
      ) throw new ConflictException('Pending federation trust is inconsistent');
      return {
        issuerId: issuer.id,
        permissions,
        key: { kid: key.kid, publicKeySpki: key.publicKeySpki },
      };
    }

    const localIdentity = await this.panelIdentity.getLocalIdentity();
    const relationship = generateFederationRelationshipKey(
      localIdentity.installationId,
      target.targetInstallationId,
    );
    try {
      const issuer = await this.prisma.$transaction(async (tx) => {
        const created = await tx.federationIssuer.create({
          data: {
            issuerInstallationId: localIdentity.installationId,
            targetInstallationId: target.targetInstallationId,
            state: 'PENDING',
            maxRole: candidate.maxRole,
            permissionPolicyJson: JSON.stringify(permissions),
            principalVersion: 1,
            keys: {
              create: {
                kid: relationship.kid,
                publicKeySpki: relationship.publicKeySpki,
                encryptedPrivateKey: relationship.encryptedPrivateKey,
                state: 'PENDING',
                validFrom: now,
              },
            },
          },
        });
        const bound = await tx.federationEnrollment.updateMany({
          where: {
            id: enrollment.id,
            enrollmentRole: 'CONTROL_PLANE',
            delegationIssuerId: null,
          },
          data: {
            state: 'MASTER_SSH_VERIFIED',
            targetInstallationId: target.targetInstallationId,
            targetManifestKid: target.manifestKid,
            targetManifestKeySpki: target.manifestPublicKeySpki,
            delegationIssuerId: created.id,
          },
        });
        if (bound.count !== 1) throw new ConflictException('Enrollment trust binding changed');
        return created;
      });
      return {
        issuerId: issuer.id,
        permissions,
        key: { kid: relationship.kid, publicKeySpki: relationship.publicKeySpki },
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Target is already enrolled or pending');
      }
      throw error;
    }
  }

  private assertTrustResponse(
    enrollmentId: string,
    target: FederationSshBootstrapResult,
    trust: {
      enrollmentId: string;
      state: 'MANIFEST_PENDING';
      target: {
        installationId: string;
        manifestKid: string;
        manifestPublicKeySpki: string;
      };
      healthPath: string;
      manifestPath: string;
    },
  ): void {
    if (
      trust?.enrollmentId !== enrollmentId ||
      trust?.state !== 'MANIFEST_PENDING' ||
      trust?.target?.installationId !== target.targetInstallationId ||
      trust?.target?.manifestKid !== target.manifestKid ||
      trust?.target?.manifestPublicKeySpki !== target.manifestPublicKeySpki ||
      trust?.healthPath !== '/api/federation/v1/health' ||
      trust?.manifestPath !== '/api/federation/v1/manifest'
    ) throw new ConflictException('Target trust response is inconsistent');
  }

  private evaluateCandidateManifest(
    manifest: SignedFederationManifest,
    candidate: EnrollmentCandidate,
  ): FederationManifestEvaluation {
    const evaluation = evaluateFederationManifest(manifest, {
      apiOrigin: candidate.apiOrigin,
      wsOrigin: candidate.wsOrigin,
      wsPath: candidate.wsPath,
      browserPublicOrigin: candidate.browserPublicOrigin,
      directTransferOrigin: candidate.directTransferOrigin,
    }, this.catalogue);
    if (!evaluation.compatible || !evaluation.hasMatchingEndpoint) {
      throw new ConflictException('Target manifest is incompatible with candidate endpoint');
    }
    return evaluation;
  }
}
