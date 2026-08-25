import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
} from '@nestjs/throttler';
import type {
  ThrottlerGenerateKeyFunction,
  ThrottlerGetTrackerFunction,
  ThrottlerModuleOptions,
  ThrottlerOptions,
} from '@nestjs/throttler/dist/throttler-module-options.interface';
import type { ThrottlerStorage } from '@nestjs/throttler/dist/throttler-storage.interface';
import { createHash } from 'node:crypto';
import { extractClientIp } from '../http/client-ip';
import { FederationActionCatalogueService } from '../../federation/federation-action-catalogue.service';
import {
  FederationRequestState,
  isVerifiedFederationRequest,
} from '../../federation/federation-request-context';

const GLOBAL_ABUSE_MULTIPLIER = 5;
const MAX_GLOBAL_LIMIT = 10_000;

interface RateLimitUser {
  id?: unknown;
  sub?: unknown;
}

interface RateLimitRequest extends FederationRequestState {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  user?: RateLimitUser | unknown;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

function stringField(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

function publicCredential(request: RateLimitRequest): string | undefined {
  const body = request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)
    ? request.body as Record<string, unknown>
    : undefined;
  return stringField(request.params?.token) ??
    stringField(request.query?.secret) ??
    stringField(body?.secret);
}

function localUserSubject(user: unknown): string | undefined {
  if (!user || typeof user !== 'object') return undefined;
  const value = user as RateLimitUser;
  return stringField(value.sub, 256) ?? stringField(value.id, 256);
}

function relayAction(
  request: RateLimitRequest,
  catalogue: FederationActionCatalogueService,
): string {
  const serverId = stringField(request.params?.serverId, 128);
  const requestTarget = request.originalUrl ?? request.url ?? '';
  if (!serverId || !requestTarget.startsWith(`/api/proxy/${serverId}/`)) return 'unclassified';
  const suffixWithQuery = requestTarget.slice(`/api/proxy/${serverId}`.length);
  const suffix = suffixWithQuery.split('?', 1)[0] || '/';
  const concretePath = suffix === '/api' || suffix.startsWith('/api/')
    ? suffix
    : `/api${suffix}`;
  try {
    return catalogue.resolveHttpByConcretePath(request.method ?? '', concretePath)?.actionId ?? 'unclassified';
  } catch {
    return 'unclassified';
  }
}

/** Controller/handler identity remains part of Nest's generated key. */
export function federationRateLimitTracker(
  request: RateLimitRequest,
  catalogue: FederationActionCatalogueService,
): string {
  const ip = extractClientIp(request as unknown as Parameters<typeof extractClientIp>[0]);
  if (isVerifiedFederationRequest(request)) {
    const federation = request.federationContext;
    return [
      'delegated',
      digest(federation.issuerId),
      digest(federation.subject),
      federation.actionId,
    ].join(':');
  }

  const credential = publicCredential(request);
  if (credential) return ['public', digest(ip), digest(credential)].join(':');

  const subject = localUserSubject(request.user);
  const serverId = stringField(request.params?.serverId, 128);
  if (subject && serverId && (request.originalUrl ?? request.url ?? '').startsWith('/api/proxy/')) {
    return [
      'relay',
      digest(subject),
      digest(serverId),
      relayAction(request, catalogue),
    ].join(':');
  }
  if (subject) return `local:${digest(subject)}`;
  return `anonymous:${digest(ip)}`;
}

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly catalogue: FederationActionCatalogueService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: RateLimitRequest): Promise<string> {
    return federationRateLimitTracker(req, this.catalogue);
  }

  protected async handleRequest(
    context: ExecutionContext,
    limit: number,
    ttl: number,
    throttler: ThrottlerOptions,
    getTracker: ThrottlerGetTrackerFunction,
    generateKey: ThrottlerGenerateKeyFunction,
  ): Promise<boolean> {
    const { req, res } = this.getRequestResponse(context);
    const ip = extractClientIp(req as Parameters<typeof extractClientIp>[0]);
    const globalTracker = `global:${digest(ip)}`;
    const globalLimit = Math.min(MAX_GLOBAL_LIMIT, Math.max(limit, limit * GLOBAL_ABUSE_MULTIPLIER));
    const globalKey = createHash('sha256')
      .update(`meowbox-rate-global-v1\0${throttler.name ?? 'default'}\0${globalTracker}`)
      .digest('hex');
    const global = await this.storageService.increment(globalKey, ttl);
    if (global.totalHits > globalLimit) {
      const suffix = throttler.name === 'default' ? '' : `-${throttler.name}`;
      res.header(`Retry-After${suffix}`, global.timeToExpire);
      await this.throwThrottlingException(context, {
        limit: globalLimit,
        ttl,
        key: globalKey,
        tracker: globalTracker,
        totalHits: global.totalHits,
        timeToExpire: global.timeToExpire,
      });
    }
    return super.handleRequest(context, limit, ttl, throttler, getTracker, generateKey);
  }
}
