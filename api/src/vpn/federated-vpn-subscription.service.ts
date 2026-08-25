import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, FederatedVpnSubscriptionSource } from '@prisma/client';
import {
  canonicalFederationJson,
  PublicEndpointDelivery,
  SignedFederatedVpnFragment,
  unsignedFederatedVpnFragment,
  validatePublicDelivery,
  validateSignedFederatedVpnFragment,
} from '@meowbox/shared';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import {
  decryptFederatedVpnFragment,
  deriveFederatedVpnSubscriptionToken,
  encryptFederatedVpnFragment,
  federatedVpnTokenHash,
} from '../common/crypto/federated-vpn-cipher';
import { FederationDispatcherService } from '../federation/federation-dispatcher.service';
import { verifyFederationPayload } from '../federation/federation-key-material';
import { PanelIdentityService } from '../federation/panel-identity.service';
import { PublicDeliveryOriginService } from '../public-delivery/public-delivery-origin.service';
import {
  FEDERATED_VPN_MAX_AGGREGATE_BYTES,
  FEDERATED_VPN_MAX_RESPONSE_BYTES,
  FEDERATED_VPN_MAX_SOURCES,
  FEDERATED_VPN_SERVICE_SUBJECT,
  FEDERATED_VPN_SOURCE_FRESH_MS,
  FEDERATED_VPN_SOURCE_MAX_STALE_MS,
} from './federated-vpn.constants';
import { FederatedVpnFragmentService } from './federated-vpn-fragment.service';

const PUBLIC_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CLOCK_SKEW_MS = 30_000;

interface SourceTarget {
  remoteServerId: string | null;
  targetInstallationId: string;
  manifestKid: string;
  manifestPublicKeySpki: string;
}

interface CachedSourceResult {
  fragment: SignedFederatedVpnFragment;
  stale: boolean;
}

export interface FederatedVpnPublicResult {
  content: string;
  state: 'fresh' | 'stale' | 'partial';
}

type SourceWithCache = FederatedVpnSubscriptionSource & {
  cache: {
    epoch: string;
    payloadEnc: string;
    fingerprint: string;
    generatedAt: Date;
    validUntil: Date;
    invalidatedAt: Date | null;
  } | null;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function equalHex(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function cacheFingerprint(fragment: SignedFederatedVpnFragment): string {
  return sha256(canonicalFederationJson(unsignedFederatedVpnFragment(fragment)));
}

async function readBoundedJson(body: AsyncIterable<Buffer>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of body) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > FEDERATED_VPN_MAX_RESPONSE_BYTES) {
      throw new ServiceUnavailableException('VPN source response exceeded bounds');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ServiceUnavailableException('VPN source response is invalid');
  }
}

@Injectable()
export class FederatedVpnSubscriptionService {
  private readonly refreshes = new Map<string, Promise<SignedFederatedVpnFragment>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly panelIdentity: PanelIdentityService,
    private readonly dispatcher: FederationDispatcherService,
    private readonly localFragments: FederatedVpnFragmentService,
    private readonly origins: PublicDeliveryOriginService,
  ) {}

  async createOrGet(
    serverId: string,
    vpnUserId: string,
    actorUserId: string,
    browserIp: string,
  ): Promise<PublicEndpointDelivery> {
    await this.assertMaster();
    const target = await this.resolveTarget(serverId);
    const fragment = await this.fetchAndVerify(target, vpnUserId, browserIp);
    const dedupeKey = sha256(`v1\0${actorUserId}\0${serverId}\0${vpnUserId}`);
    let row = await this.prisma.federatedVpnSubscription.findUnique({
      where: { dedupeKey },
    });
    if (row && (row.state !== 'ACTIVE' || row.revokedAt !== null)) row = null;

    if (row) {
      const source = await this.prisma.federatedVpnSubscriptionSource.findFirst({
        where: {
          subscriptionId: row.id,
          targetInstallationId: target.targetInstallationId,
          vpnUserId,
          state: 'ACTIVE',
        },
      });
      if (!source) throw new ConflictException('VPN subscription source binding changed');
      await this.persistCache(source.id, fragment);
      return this.delivery(row.id, row.tokenHash);
    }

    const subscriptionId = randomUUID();
    const sourceId = randomUUID();
    const token = deriveFederatedVpnSubscriptionToken(subscriptionId);
    const tokenHash = federatedVpnTokenHash(token);
    try {
      await this.prisma.federatedVpnSubscription.create({
        data: {
          id: subscriptionId,
          dedupeKey,
          tokenHash,
          createdByUserId: actorUserId,
          state: 'ACTIVE',
          maxStaleSeconds: FEDERATED_VPN_SOURCE_MAX_STALE_MS / 1000,
          sources: {
            create: {
              id: sourceId,
              remoteServerId: target.remoteServerId,
              targetInstallationId: target.targetInstallationId,
              vpnUserId,
              position: 0,
              state: 'ACTIVE',
              lastSuccessAt: new Date(),
              cache: {
                create: this.cacheCreateData(sourceId, fragment),
              },
            },
          },
        },
      });
      return this.delivery(subscriptionId, tokenHash);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const concurrent = await this.prisma.federatedVpnSubscription.findUnique({
        where: { dedupeKey },
      });
      if (!concurrent || concurrent.state !== 'ACTIVE') throw new ConflictException('VPN subscription conflict');
      return this.delivery(concurrent.id, concurrent.tokenHash);
    }
  }

  async addSource(
    subscriptionId: string,
    serverId: string,
    vpnUserId: string,
    actorUserId: string,
    browserIp: string,
  ): Promise<PublicEndpointDelivery> {
    const subscription = await this.ownedSubscription(subscriptionId, actorUserId);
    const count = await this.prisma.federatedVpnSubscriptionSource.count({
      where: { subscriptionId, state: 'ACTIVE' },
    });
    if (count >= FEDERATED_VPN_MAX_SOURCES) {
      throw new ConflictException('VPN subscription source limit reached');
    }
    const target = await this.resolveTarget(serverId);
    const fragment = await this.fetchAndVerify(target, vpnUserId, browserIp);
    const sourceId = randomUUID();
    try {
      await this.prisma.federatedVpnSubscriptionSource.create({
        data: {
          id: sourceId,
          subscriptionId,
          remoteServerId: target.remoteServerId,
          targetInstallationId: target.targetInstallationId,
          vpnUserId,
          position: count,
          state: 'ACTIVE',
          lastSuccessAt: new Date(),
          cache: { create: this.cacheCreateData(sourceId, fragment) },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('VPN subscription source already exists');
      }
      throw error;
    }
    return this.delivery(subscription.id, subscription.tokenHash);
  }

  async removeSource(
    subscriptionId: string,
    sourceId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.ownedSubscription(subscriptionId, actorUserId);
    await this.prisma.$transaction(async (tx) => {
      const sources = await tx.federatedVpnSubscriptionSource.findMany({
        where: { subscriptionId, state: 'ACTIVE' },
        orderBy: { position: 'asc' },
      });
      if (sources.length <= 1) throw new ConflictException('VPN subscription requires one source');
      const source = sources.find((item) => item.id === sourceId);
      if (!source) throw new NotFoundException();
      await tx.federatedVpnSubscriptionSource.delete({ where: { id: source.id } });
      const remaining = sources.filter((item) => item.id !== source.id);
      for (const [position, item] of remaining.entries()) {
        await tx.federatedVpnSubscriptionSource.update({
          where: { id: item.id },
          data: { position },
        });
      }
    });
  }

  async reorderSources(
    subscriptionId: string,
    sourceIds: readonly string[],
    actorUserId: string,
  ): Promise<void> {
    await this.ownedSubscription(subscriptionId, actorUserId);
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw new ConflictException('VPN subscription source order has duplicates');
    }
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.federatedVpnSubscriptionSource.findMany({
        where: { subscriptionId, state: 'ACTIVE' },
        select: { id: true },
      });
      if (
        current.length !== sourceIds.length ||
        current.some((source) => !sourceIds.includes(source.id))
      ) throw new ConflictException('VPN subscription source set changed');
      for (const [index, sourceId] of sourceIds.entries()) {
        await tx.federatedVpnSubscriptionSource.update({
          where: { id: sourceId },
          data: { position: index + FEDERATED_VPN_MAX_SOURCES },
        });
      }
      for (const [position, sourceId] of sourceIds.entries()) {
        await tx.federatedVpnSubscriptionSource.update({
          where: { id: sourceId },
          data: { position },
        });
      }
    });
  }

  async rotate(
    subscriptionId: string,
    actorUserId: string,
  ): Promise<PublicEndpointDelivery> {
    const current = await this.prisma.federatedVpnSubscription.findFirst({
      where: { id: subscriptionId, createdByUserId: actorUserId, state: 'ACTIVE', revokedAt: null },
      include: { sources: { where: { state: 'ACTIVE' }, orderBy: { position: 'asc' } } },
    });
    if (!current) throw new NotFoundException();
    const nextId = randomUUID();
    const nextHash = federatedVpnTokenHash(deriveFederatedVpnSubscriptionToken(nextId));
    await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.federatedVpnSubscription.updateMany({
        where: { id: current.id, state: 'ACTIVE', revokedAt: null },
        data: { state: 'REVOKED', revokedAt: new Date(), dedupeKey: null },
      });
      if (revoked.count !== 1) throw new ConflictException('VPN subscription changed');
      await tx.federatedVpnSubscription.create({
        data: {
          id: nextId,
          dedupeKey: current.dedupeKey,
          tokenHash: nextHash,
          createdByUserId: current.createdByUserId,
          state: 'ACTIVE',
          maxStaleSeconds: current.maxStaleSeconds,
          sources: {
            create: current.sources.map((source) => ({
              remoteServerId: source.remoteServerId,
              targetInstallationId: source.targetInstallationId,
              vpnUserId: source.vpnUserId,
              position: source.position,
              state: 'ACTIVE',
            })),
          },
        },
      });
    });
    return this.delivery(nextId, nextHash);
  }

  async revoke(subscriptionId: string, actorUserId: string): Promise<void> {
    await this.ownedSubscription(subscriptionId, actorUserId);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.federatedVpnSubscription.update({
        where: { id: subscriptionId },
        data: { state: 'REVOKED', revokedAt: now, dedupeKey: null },
      }),
      this.prisma.federatedVpnSubscriptionSource.updateMany({
        where: { subscriptionId },
        data: { state: 'REVOKED', invalidatedAt: now },
      }),
      this.prisma.federatedVpnSubscriptionCache.updateMany({
        where: { source: { subscriptionId } },
        data: { invalidatedAt: now },
      }),
    ]);
  }

  async publicSubscription(
    token: string,
    browserIp: string,
    now = new Date(),
  ): Promise<FederatedVpnPublicResult> {
    if (!PUBLIC_TOKEN.test(token)) throw new NotFoundException();
    const subscription = await this.prisma.federatedVpnSubscription.findUnique({
      where: { tokenHash: federatedVpnTokenHash(token) },
      include: {
        sources: {
          where: { state: 'ACTIVE', invalidatedAt: null },
          include: { cache: true },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (
      !subscription ||
      subscription.state !== 'ACTIVE' ||
      subscription.revokedAt !== null ||
      subscription.sources.length === 0 ||
      subscription.sources.length > FEDERATED_VPN_MAX_SOURCES
    ) throw new NotFoundException();
    const expected = deriveFederatedVpnSubscriptionToken(subscription.id);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(token))) throw new NotFoundException();

    const maxStaleMs = Math.min(
      subscription.maxStaleSeconds * 1000,
      FEDERATED_VPN_SOURCE_MAX_STALE_MS,
    );
    const results = await Promise.all(subscription.sources.map(async (source) => {
      try {
        return await this.sourceResult(source, browserIp, now, maxStaleMs);
      } catch {
        return null;
      }
    }));
    const usable = results.filter((result): result is CachedSourceResult => result !== null);
    if (usable.length === 0) {
      throw new ServiceUnavailableException('VPN subscription sources are unavailable');
    }

    const seen = new Set<string>();
    const entries: string[] = [];
    let bytes = 0;
    for (const result of usable) {
      for (const entry of result.fragment.entries) {
        if (seen.has(entry.fingerprint)) continue;
        const extra = Buffer.byteLength(entry.content, 'utf8') + (entries.length === 0 ? 0 : 1);
        if (bytes + extra > FEDERATED_VPN_MAX_AGGREGATE_BYTES) {
          throw new ServiceUnavailableException('VPN subscription aggregate exceeded bounds');
        }
        seen.add(entry.fingerprint);
        entries.push(entry.content);
        bytes += extra;
      }
    }
    const missing = usable.length !== subscription.sources.length;
    const stale = usable.some((result) => result.stale);
    return {
      content: Buffer.from(entries.join('\n'), 'utf8').toString('base64'),
      state: missing ? 'partial' : stale ? 'stale' : 'fresh',
    };
  }

  private async sourceResult(
    source: SourceWithCache,
    browserIp: string,
    now: Date,
    maxStaleMs: number,
  ): Promise<CachedSourceResult> {
    if (
      source.cache &&
      source.cache.invalidatedAt === null &&
      source.cache.generatedAt.getTime() + FEDERATED_VPN_SOURCE_FRESH_MS > now.getTime() &&
      source.cache.validUntil.getTime() > now.getTime()
    ) {
      return { fragment: await this.verifyCached(source), stale: false };
    }
    try {
      return { fragment: await this.refreshSource(source, browserIp), stale: false };
    } catch {
      await this.prisma.federatedVpnSubscriptionSource.updateMany({
        where: { id: source.id, state: 'ACTIVE' },
        data: { lastFailureAt: now, lastFailureCode: 'VPN_SOURCE_UNAVAILABLE' },
      });
      if (
        source.cache &&
        source.cache.invalidatedAt === null &&
        source.cache.generatedAt.getTime() + maxStaleMs > now.getTime() &&
        source.cache.validUntil.getTime() > now.getTime()
      ) return { fragment: await this.verifyCached(source), stale: true };
      throw new ServiceUnavailableException('VPN source is unavailable');
    }
  }

  private async refreshSource(
    source: SourceWithCache,
    browserIp: string,
  ): Promise<SignedFederatedVpnFragment> {
    const existing = this.refreshes.get(source.id);
    if (existing) return existing;
    const refresh = (async () => {
      const target = await this.resolveSourceTarget(source);
      const fragment = await this.fetchAndVerify(target, source.vpnUserId, browserIp);
      await this.persistCache(source.id, fragment);
      return fragment;
    })();
    this.refreshes.set(source.id, refresh);
    try {
      return await refresh;
    } finally {
      if (this.refreshes.get(source.id) === refresh) this.refreshes.delete(source.id);
    }
  }

  private async verifyCached(source: SourceWithCache): Promise<SignedFederatedVpnFragment> {
    if (!source.cache) throw new ServiceUnavailableException('VPN source cache is unavailable');
    const fragment = decryptFederatedVpnFragment<SignedFederatedVpnFragment>(
      source.id,
      source.cache.payloadEnc,
    );
    if (
      fragment.epoch !== source.cache.epoch ||
      Date.parse(fragment.issuedAt) !== source.cache.generatedAt.getTime() ||
      Date.parse(fragment.expiresAt) !== source.cache.validUntil.getTime() ||
      !equalHex(source.cache.fingerprint, cacheFingerprint(fragment))
    ) throw new ServiceUnavailableException('VPN source cache binding is invalid');
    const target = await this.resolveSourceTarget(source);
    return this.verifyFragment(fragment, target, source.vpnUserId);
  }

  private async resolveSourceTarget(source: FederatedVpnSubscriptionSource): Promise<SourceTarget> {
    const identity = await this.panelIdentity.getLocalIdentity();
    if (source.remoteServerId === null && source.targetInstallationId === identity.installationId) {
      return {
        remoteServerId: null,
        targetInstallationId: identity.installationId,
        manifestKid: identity.manifestKid,
        manifestPublicKeySpki: identity.manifestPublicKeySpki,
      };
    }
    if (!source.remoteServerId) throw new ServiceUnavailableException('VPN source target is unavailable');
    return this.resolveTarget(source.remoteServerId, source.targetInstallationId);
  }

  private async resolveTarget(
    serverId: string,
    expectedInstallationId?: string,
  ): Promise<SourceTarget> {
    const identity = await this.panelIdentity.getLocalIdentity();
    if (serverId === 'main') {
      if (expectedInstallationId && expectedInstallationId !== identity.installationId) {
        throw new ServiceUnavailableException('VPN source target changed');
      }
      return {
        remoteServerId: null,
        targetInstallationId: identity.installationId,
        manifestKid: identity.manifestKid,
        manifestPublicKeySpki: identity.manifestPublicKeySpki,
      };
    }
    const remote = await this.prisma.remoteServer.findUnique({ where: { id: serverId } });
    if (
      !remote ||
      !remote.installationId ||
      !remote.targetManifestKid ||
      !remote.targetManifestPublicKeySpki ||
      (expectedInstallationId && remote.installationId !== expectedInstallationId)
    ) throw new NotFoundException('VPN source target not found');
    return {
      remoteServerId: remote.id,
      targetInstallationId: remote.installationId,
      manifestKid: remote.targetManifestKid,
      manifestPublicKeySpki: remote.targetManifestPublicKeySpki,
    };
  }

  private async fetchAndVerify(
    target: SourceTarget,
    vpnUserId: string,
    browserIp: string,
  ): Promise<SignedFederatedVpnFragment> {
    if (target.remoteServerId === null) {
      return this.verifyFragment(
        await this.localFragments.create(vpnUserId),
        target,
        vpnUserId,
      );
    }
    const response = await this.dispatcher.dispatchService({
      targetInstallationId: target.targetInstallationId,
      inboundTarget: `/api/proxy/${target.targetInstallationId}/federation/v1/vpn/fragments/${vpnUserId}`,
      method: 'GET',
      rawHeaders: ['Accept', 'application/json'],
      body: Buffer.alloc(0),
      serviceSubject: FEDERATED_VPN_SERVICE_SUBJECT,
      browserIp,
    });
    if (response.statusCode !== 200) {
      response.body.destroy();
      throw new ServiceUnavailableException('VPN source rejected the fragment request');
    }
    const wrapper = await readBoundedJson(response.body);
    if (
      !wrapper ||
      typeof wrapper !== 'object' ||
      Array.isArray(wrapper) ||
      (wrapper as { success?: unknown }).success !== true ||
      !Object.prototype.hasOwnProperty.call(wrapper, 'data')
    ) throw new ServiceUnavailableException('VPN source response is invalid');
    return this.verifyFragment(
      (wrapper as { data: unknown }).data,
      target,
      vpnUserId,
    );
  }

  private verifyFragment(
    value: unknown,
    target: SourceTarget,
    vpnUserId: string,
    now = new Date(),
  ): SignedFederatedVpnFragment {
    let fragment: SignedFederatedVpnFragment;
    try {
      fragment = validateSignedFederatedVpnFragment(value);
    } catch (error) {
      throw new ServiceUnavailableException('VPN source fragment contract is invalid', { cause: error });
    }
    if (
      fragment.targetInstallationId !== target.targetInstallationId ||
      fragment.sourceId !== vpnUserId ||
      fragment.signature.kid !== target.manifestKid ||
      Date.parse(fragment.issuedAt) > now.getTime() + CLOCK_SKEW_MS ||
      Date.parse(fragment.expiresAt) <= now.getTime()
    ) throw new ServiceUnavailableException('VPN source fragment binding is invalid');
    for (const entry of fragment.entries) {
      if (!equalHex(entry.fingerprint, sha256(entry.content))) {
        throw new ServiceUnavailableException('VPN source fragment fingerprint is invalid');
      }
    }
    if (!verifyFederationPayload(
      Buffer.from(canonicalFederationJson(unsignedFederatedVpnFragment(fragment)), 'utf8'),
      fragment.signature.value,
      target.manifestPublicKeySpki,
    )) throw new ServiceUnavailableException('VPN source fragment signature is invalid');
    return fragment;
  }

  private cacheCreateData(sourceId: string, fragment: SignedFederatedVpnFragment) {
    return {
      epoch: fragment.epoch,
      payloadEnc: encryptFederatedVpnFragment(sourceId, fragment),
      fingerprint: cacheFingerprint(fragment),
      generatedAt: new Date(fragment.issuedAt),
      validUntil: new Date(fragment.expiresAt),
    };
  }

  private async persistCache(
    sourceId: string,
    fragment: SignedFederatedVpnFragment,
  ): Promise<void> {
    const data = this.cacheCreateData(sourceId, fragment);
    await this.prisma.$transaction([
      this.prisma.federatedVpnSubscriptionCache.upsert({
        where: { sourceId },
        create: { sourceId, ...data },
        update: { ...data, invalidatedAt: null },
      }),
      this.prisma.federatedVpnSubscriptionSource.update({
        where: { id: sourceId },
        data: { lastSuccessAt: new Date(), lastFailureAt: null, lastFailureCode: null },
      }),
    ]);
  }

  private async ownedSubscription(id: string, actorUserId: string) {
    await this.assertMaster();
    const subscription = await this.prisma.federatedVpnSubscription.findFirst({
      where: { id, createdByUserId: actorUserId, state: 'ACTIVE', revokedAt: null },
    });
    if (!subscription) throw new NotFoundException();
    return subscription;
  }

  private async assertMaster(): Promise<void> {
    const identity = await this.panelIdentity.getLocalIdentity();
    if (identity.installationRole !== 'MASTER') {
      throw new ConflictException('VPN federation subscriptions belong to the control plane');
    }
  }

  private async delivery(id: string, storedTokenHash: string): Promise<PublicEndpointDelivery> {
    const identity = await this.panelIdentity.getLocalIdentity();
    const token = deriveFederatedVpnSubscriptionToken(id);
    if (!equalHex(storedTokenHash, federatedVpnTokenHash(token))) {
      throw new ServiceUnavailableException('VPN subscription token binding is invalid');
    }
    return validatePublicDelivery({
      kind: 'PublicEndpoint',
      purpose: 'VPN_SUBSCRIPTION',
      targetInstallationId: identity.installationId,
      resource: { kind: 'VPN_SUBSCRIPTION', id },
      method: 'GET',
      allowedHeaders: [],
      cachePolicy: 'NO_STORE',
      referrerPolicy: 'NO_REFERRER',
      expiresAt: null,
      browserReachabilityRequired: false,
      rangeSupported: false,
      resumeSupported: false,
      fallbackReason: null,
      url: `${this.origins.browserPublicOrigin()}/api/public/v1/vpn/subscriptions/${token}`,
      reusable: true,
    }) as PublicEndpointDelivery;
  }
}
