import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Dispatcher } from 'undici';
import {
  createPinnedFederationDispatcher,
  PinnedFederationDispatcher,
} from './pinned-dispatcher';

export interface FederationDispatcherTarget {
  apiOrigin: string;
  spkiSha256: string;
  caCertificatePem: string | null;
  connectTimeoutMs: number;
}

function targetKey(target: FederationDispatcherTarget): string {
  return createHash('sha256')
    .update(target.apiOrigin)
    .update('\0')
    .update(target.spkiSha256)
    .update('\0')
    .update(target.caCertificatePem ?? '')
    .update('\0')
    .update(String(target.connectTimeoutMs))
    .digest('hex');
}

@Injectable()
export class FederationDispatcherPoolService implements OnModuleDestroy {
  private readonly dispatchers = new Map<string, PinnedFederationDispatcher>();

  get(target: FederationDispatcherTarget): Dispatcher {
    const key = targetKey(target);
    const existing = this.dispatchers.get(key);
    if (existing) return existing.dispatcher;
    const created = createPinnedFederationDispatcher(target.apiOrigin, {
      spkiSha256: target.spkiSha256,
      connectTimeoutMs: target.connectTimeoutMs,
      ...(target.caCertificatePem ? { ca: target.caCertificatePem } : {}),
    });
    this.dispatchers.set(key, created);
    return created.dispatcher;
  }

  async onModuleDestroy(): Promise<void> {
    const active = [...this.dispatchers.values()];
    this.dispatchers.clear();
    await Promise.allSettled(active.map(({ close }) => close()));
  }
}
