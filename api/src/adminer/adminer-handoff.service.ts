import {
  GoneException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AppHandoffDelivery, PublicDeliveryPurpose } from '@meowbox/shared';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  adminerHandoffAad,
  decryptAdminerHandoffPayload,
  encryptAdminerHandoffPayload,
  encryptAdminerSessionCookie,
} from '../common/crypto/adminer-cipher';
import { PrismaService } from '../common/prisma.service';
import { PanelIdentityService } from '../federation/panel-identity.service';
import { PublicDeliveryOriginService } from '../public-delivery/public-delivery-origin.service';

const HANDOFF_TTL_MS = 60_000;
const SESSION_TTL_SECONDS = 900;
const COOKIE_NAME = '__Secure-meowbox_adminer_session';
const COOKIE_MAX_BYTES = 3_800;
const HANDOFF_RETENTION_MS = 24 * 60 * 60 * 1000;
const HANDOFF_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const RESOURCE_KIND = /^[A-Z][A-Z0-9_]{1,63}$/;
const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export interface AdminerCredentials {
  driver: 'server' | 'pgsql';
  host: string;
  port: number | null;
  socket: string | null;
  user: string;
  pass: string;
  database: string;
  service?: 'manticore';
  site?: string;
}

interface AdminerHandoffPayload extends AdminerCredentials {
  v: 2;
  kind: 'handoff';
  audience: 'adminer-handoff';
  targetInstallationId: string;
  handoffId: string;
  purpose: 'ADMINER' | 'MANTICORE';
  resourceKind: string;
  resourceId: string;
  issuedAt: number;
  expiresAt: number;
}

interface AdminerSessionPayload extends AdminerCredentials {
  v: 2;
  kind: 'session';
  audience: 'adminer';
  targetInstallationId: string;
  purpose: 'ADMINER' | 'MANTICORE';
  resourceKind: string;
  resourceId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AdminerActor {
  userId: string;
  role: string;
}

export interface CreateAdminerHandoffInput {
  purpose: Extract<PublicDeliveryPurpose, 'ADMINER' | 'MANTICORE'>;
  resourceKind: string;
  resourceId: string;
  credentials: AdminerCredentials;
  actor: AdminerActor;
}

export interface ConsumedAdminerHandoff {
  cookieHeader: string;
  expiresAt: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function secureEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function assertCredentials(value: AdminerCredentials): void {
  if (
    !['server', 'pgsql'].includes(value.driver) ||
    typeof value.host !== 'string' || value.host.length < 1 || value.host.length > 255 ||
    !/^[A-Za-z0-9._:-]+$/.test(value.host) ||
    (value.port !== null && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) ||
    (value.socket !== null && (typeof value.socket !== 'string' || value.socket.length < 1 || value.socket.length > 512)) ||
    (value.socket !== null && (
      !/^\/[A-Za-z0-9._/-]+$/.test(value.socket) ||
      value.socket.split('/').some((segment) => segment === '..')
    )) ||
    (value.port === null) === (value.socket === null) ||
    typeof value.user !== 'string' || value.user.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.user) ||
    typeof value.pass !== 'string' || value.pass.length > 1024 || value.pass.includes('\0') ||
    typeof value.database !== 'string' || value.database.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.database) ||
    (value.service !== undefined && value.service !== 'manticore') ||
    (value.site !== undefined && (typeof value.site !== 'string' || value.site.length > 128))
  ) {
    throw new Error('Adminer credentials are invalid');
  }
}

function validatePayload(
  payload: AdminerHandoffPayload,
  expected: {
    id: string;
    targetInstallationId: string;
    purpose: string;
    resourceKind: string;
    resourceId: string;
    expiresAt: Date;
  },
  now: number,
): void {
  assertCredentials(payload);
  if (
    payload.v !== 2 ||
    payload.kind !== 'handoff' ||
    payload.audience !== 'adminer-handoff' ||
    payload.handoffId !== expected.id ||
    payload.targetInstallationId !== expected.targetInstallationId ||
    payload.purpose !== expected.purpose ||
    payload.resourceKind !== expected.resourceKind ||
    payload.resourceId !== expected.resourceId ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt !== expected.expiresAt.getTime() ||
    payload.expiresAt <= now ||
    payload.issuedAt > now + 30_000
  ) {
    throw new UnauthorizedException('Adminer handoff payload is invalid');
  }
}

@Injectable()
export class AdminerHandoffService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminerHandoffService.name);
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly origins: PublicDeliveryOriginService,
    private readonly panelIdentity: PanelIdentityService,
  ) {}

  onModuleInit(): void {
    void this.cleanupExpired();
    this.cleanupTimer = setInterval(
      () => void this.cleanupExpired(),
      HANDOFF_CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  async create(input: CreateAdminerHandoffInput): Promise<AppHandoffDelivery> {
    if (
      !['ADMINER', 'MANTICORE'].includes(input.purpose) ||
      !RESOURCE_KIND.test(input.resourceKind) ||
      !RESOURCE_ID.test(input.resourceId) ||
      !/^[0-9a-f-]{36}$/i.test(input.actor.userId) ||
      !['ADMIN', 'MANAGER'].includes(input.actor.role)
    ) {
      throw new Error('Adminer resource binding is invalid');
    }
    assertCredentials(input.credentials);
    const identity = await this.panelIdentity.getLocalIdentity();
    const publicOrigin = this.origins.browserPublicOrigin();
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + HANDOFF_TTL_MS);
    const actor = await this.actorSnapshot(input.actor.userId);
    const payload: AdminerHandoffPayload = {
      v: 2,
      kind: 'handoff',
      audience: 'adminer-handoff',
      targetInstallationId: identity.installationId,
      handoffId: id,
      purpose: input.purpose,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      ...input.credentials,
      issuedAt: now,
      expiresAt: expiresAt.getTime(),
    };
    const payloadEnc = encryptAdminerHandoffPayload(
      payload,
      adminerHandoffAad({
        targetInstallationId: identity.installationId,
        handoffId: id,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
      }),
    );
    await this.prisma.adminerHandoff.create({
      data: {
        id,
        targetInstallationId: identity.installationId,
        purpose: input.purpose,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        secretHash: sha256(secret),
        payloadEnc,
        actorKind: actor.kind,
        actorSubjectHash: actor.subjectHash,
        actorRole: input.actor.role,
        expiresAt,
      },
    });
    this.logger.log(`public.adminer_handoff outcome=issued purpose=${input.purpose} actor=${actor.kind}`);
    return {
      kind: 'AppHandoff',
      purpose: input.purpose,
      targetInstallationId: identity.installationId,
      resource: { kind: input.resourceKind, id: input.resourceId },
      method: 'GET',
      allowedHeaders: [],
      cachePolicy: 'NO_STORE',
      referrerPolicy: 'NO_REFERRER',
      expiresAt: expiresAt.toISOString(),
      browserReachabilityRequired: true,
      rangeSupported: false,
      resumeSupported: false,
      fallbackReason: null,
      url: `${publicOrigin}/adminer/#handoff=${id}.${secret}`,
      oneTime: true,
    };
  }

  async consume(id: string, secret: string): Promise<ConsumedAdminerHandoff> {
    const now = Date.now();
    const secretHash = sha256(secret);
    const handoff = await this.prisma.adminerHandoff.findUnique({ where: { id } });
    if (!handoff || !secureEqualHex(handoff.secretHash, secretHash)) {
      throw new UnauthorizedException('Adminer handoff is invalid');
    }
    if (handoff.consumedAt || handoff.expiresAt.getTime() <= now) {
      throw new GoneException('Adminer handoff expired or was already consumed');
    }
    const identity = await this.panelIdentity.getLocalIdentity();
    if (handoff.targetInstallationId !== identity.installationId) {
      throw new UnauthorizedException('Adminer handoff target mismatch');
    }
    const payload = decryptAdminerHandoffPayload<AdminerHandoffPayload>(
      handoff.payloadEnc,
      adminerHandoffAad({
        targetInstallationId: handoff.targetInstallationId,
        handoffId: handoff.id,
        resourceKind: handoff.resourceKind,
        resourceId: handoff.resourceId,
      }),
    );
    validatePayload(payload, handoff, now);
    const consumed = await this.prisma.adminerHandoff.updateMany({
      where: {
        id: handoff.id,
        secretHash,
        consumedAt: null,
        expiresAt: { gt: new Date(now) },
      },
      data: { consumedAt: new Date(now) },
    });
    if (consumed.count !== 1) {
      throw new GoneException('Adminer handoff expired or was already consumed');
    }
    const expiresAt = new Date(now + SESSION_TTL_SECONDS * 1000);
    const session: AdminerSessionPayload = {
      v: 2,
      kind: 'session',
      audience: 'adminer',
      targetInstallationId: handoff.targetInstallationId,
      purpose: handoff.purpose as 'ADMINER' | 'MANTICORE',
      resourceKind: handoff.resourceKind,
      resourceId: handoff.resourceId,
      driver: payload.driver,
      host: payload.host,
      port: payload.port,
      socket: payload.socket,
      user: payload.user,
      pass: payload.pass,
      database: payload.database,
      ...(payload.service ? { service: payload.service } : {}),
      ...(payload.site ? { site: payload.site } : {}),
      issuedAt: now,
      expiresAt: expiresAt.getTime(),
    };
    const cookieValue = encryptAdminerSessionCookie(session, handoff.targetInstallationId);
    const cookieHeader = [
      `${COOKIE_NAME}=${cookieValue}`,
      `Max-Age=${SESSION_TTL_SECONDS}`,
      'Path=/adminer',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
    ].join('; ');
    if (Buffer.byteLength(cookieHeader, 'utf8') > COOKIE_MAX_BYTES) {
      throw new ServiceUnavailableException('Adminer session cookie exceeds safe size');
    }
    this.logger.log(`public.adminer_handoff outcome=consumed purpose=${handoff.purpose}`);
    return { cookieHeader, expiresAt: expiresAt.toISOString() };
  }

  private async cleanupExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - HANDOFF_RETENTION_MS);
    try {
      const deleted = await this.prisma.adminerHandoff.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: cutoff } },
            { consumedAt: { lt: cutoff } },
          ],
        },
      });
      if (deleted.count > 0) {
        this.logger.log(`public.adminer_handoff outcome=cleanup count=${deleted.count}`);
      }
    } catch (error) {
      this.logger.warn(`public.adminer_handoff outcome=cleanup_failed type=${(error as Error).name}`);
    }
  }

  private async actorSnapshot(userId: string): Promise<{ kind: string; subjectHash: string }> {
    const principal = await this.prisma.federatedPrincipal.findUnique({
      where: { userId },
      select: { subject: true, issuerId: true },
    });
    return principal
      ? { kind: 'FEDERATED', subjectHash: sha256(`${principal.issuerId}\n${principal.subject}`) }
      : { kind: 'LOCAL', subjectHash: sha256(`local\n${userId}`) };
  }
}
