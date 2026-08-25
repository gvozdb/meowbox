import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  FederatedWsAckPayload,
  FederatedWsEnvelope,
  FederatedWsStatePayload,
  validateFederatedWsAck,
  validateFederatedWsEnvelope,
  validateFederatedWsState,
} from '@meowbox/shared';
import { randomUUID } from 'node:crypto';
import { Socket as BrowserSocket } from 'socket.io';
import { io, Socket as UpstreamSocket } from 'socket.io-client';
import {
  FederationWsChannelIssuerService,
  FederationWsIssueError,
  IssuedFederationWsChannel,
} from '../federation/federation-ws-channel-issuer.service';
import { createPinnedSocketAgent, PinnedSocketAgent } from '../federation/federation-socket-dialer';
import {
  FederatedSocketPolicyAction,
  FederatedSocketPolicyService,
} from '../federation/federated-socket-policy';
import { MasterFederationActor } from '../federation/federation-dispatcher.service';

const MAX_PRE_READY_EVENTS = 32;
const MAX_PRE_READY_BYTES = 256 * 1024;
const MAX_SUBSCRIPTIONS = 20;
const MAX_PENDING_MESSAGES = 256;
const MAX_PENDING_BYTES = 1024 * 1024;
const ACK_TIMEOUT_MS = 10_000;
const MIN_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 30_000;
const ASSERTION_REFRESH_ADVANCE_MS = 10_000;

type BrowserAck = (payload: unknown) => void;

interface PendingMessage {
  callback: BrowserAck | null;
  timeout: NodeJS.Timeout;
  bytes: number;
  sequence: number;
}

interface DesiredSubscription {
  action: FederatedSocketPolicyAction;
  payload: unknown;
  bytes: number;
}

interface BridgeSession {
  browser: BrowserSocket;
  targetInstallationId: string;
  actor: MasterFederationActor;
  browserIp: string;
  epoch: number;
  outgoingSequence: number;
  incomingSequence: number;
  state: FederatedWsStatePayload['state'];
  allowedActionIds: Set<string>;
  upstream: UpstreamSocket | null;
  pinnedAgent: PinnedSocketAgent | null;
  pending: Map<string, PendingMessage>;
  pendingBytes: number;
  subscriptions: Map<string, DesiredSubscription>;
  preReadyCount: number;
  preReadyBytes: number;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  refreshTimer: NodeJS.Timeout | null;
  closing: boolean;
  rateByAction: Map<string, { windowStartedAt: number; count: number }>;
}

function jsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Socket payload is not JSON serializable');
  return Buffer.byteLength(encoded, 'utf8');
}

function stablePayload(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stablePayload).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stablePayload(record[key])}`).join(',')}}`;
}

function subscriptionKey(action: FederatedSocketPolicyAction, payload: unknown): string {
  const baseEvent = action.event.replace(/:unsubscribe$/, ':subscribe');
  return `${baseEvent}\0${stablePayload(payload)}`;
}

function callbackResult(ack: FederatedWsAckPayload): unknown {
  if (ack.outcome === 'ACCEPTED' || ack.outcome === 'COMPLETED') {
    return ack.result ?? { accepted: true };
  }
  return {
    error: ack.message ?? 'Remote WebSocket action was rejected',
    code: ack.code ?? 'REMOTE_ACTION_REJECTED',
  };
}

@Injectable()
export class FederatedSocketBridgeService implements OnModuleDestroy {
  private readonly logger = new Logger(FederatedSocketBridgeService.name);
  private readonly sessions = new Map<string, BridgeSession>();

  constructor(
    private readonly issuer: FederationWsChannelIssuerService,
    private readonly policy: FederatedSocketPolicyService,
  ) {}

  async attach(
    browser: BrowserSocket,
    targetInstallationId: string,
    actor: MasterFederationActor,
    browserIp: string,
  ): Promise<void> {
    this.detach(browser.id);
    const session: BridgeSession = {
      browser,
      targetInstallationId,
      actor,
      browserIp,
      epoch: 0,
      outgoingSequence: 0,
      incomingSequence: 0,
      state: 'MASTER_CONNECTED',
      allowedActionIds: new Set(),
      upstream: null,
      pinnedAgent: null,
      pending: new Map(),
      pendingBytes: 0,
      subscriptions: new Map(),
      preReadyCount: 0,
      preReadyBytes: 0,
      reconnectAttempt: 0,
      reconnectTimer: null,
      refreshTimer: null,
      closing: false,
      rateByAction: new Map(),
    };
    this.sessions.set(browser.id, session);
    this.registerBrowserCommands(session);
    this.emitState(session, 'MASTER_CONNECTED', 'TARGET_CONNECTING', null);
    await this.connect(session);
  }

  detach(browserId: string): void {
    const session = this.sessions.get(browserId);
    if (!session) return;
    session.closing = true;
    this.sessions.delete(browserId);
    this.clearTimer(session, 'reconnectTimer');
    this.clearTimer(session, 'refreshTimer');
    this.closeUpstream(session);
    this.rejectPending(session, 'REMOTE_CHANNEL_CLOSED', 'Remote WebSocket channel closed');
  }

  onModuleDestroy(): void {
    for (const browserId of [...this.sessions.keys()]) this.detach(browserId);
  }

  private registerBrowserCommands(session: BridgeSession): void {
    for (const action of this.policy.actionsForRole(session.actor.role)) {
      if (action.direction !== 'browser_to_api') continue;
      session.browser.on(action.event, (...args: unknown[]) => {
        const last = args.at(-1);
        const callback = typeof last === 'function' ? last as BrowserAck : null;
        const payload = typeof args[0] === 'function' || args.length === 0
          ? {}
          : args[0];
        void this.handleBrowserCommand(session, action, payload, callback);
      });
    }
  }

  private async handleBrowserCommand(
    session: BridgeSession,
    action: FederatedSocketPolicyAction,
    payload: unknown,
    callback: BrowserAck | null,
  ): Promise<void> {
    if (session.closing || !this.sessions.has(session.browser.id)) return;
    let bytes: number;
    try {
      bytes = jsonBytes(payload);
      this.policy.validatePayload(action, payload);
    } catch {
      callback?.({ error: 'Invalid socket payload', code: 'REMOTE_SCHEMA_MISMATCH' });
      return;
    }
    if (bytes > MAX_PRE_READY_BYTES) {
      callback?.({ error: 'Socket payload is too large', code: 'REMOTE_PAYLOAD_TOO_LARGE' });
      return;
    }
    const nowMs = Date.now();
    const rate = session.rateByAction.get(action.actionId);
    if (!rate || nowMs - rate.windowStartedAt >= 1_000) {
      session.rateByAction.set(action.actionId, { windowStartedAt: nowMs, count: 1 });
    } else if (rate.count >= 100) {
      callback?.({ error: 'Remote WebSocket action rate limit exceeded', code: 'REMOTE_RATE_LIMITED' });
      return;
    } else {
      rate.count += 1;
    }
    if (session.allowedActionIds.size > 0 && !session.allowedActionIds.has(action.actionId)) {
      callback?.({ error: 'Remote action is unavailable', code: 'REMOTE_ACTION_UNAVAILABLE' });
      return;
    }
    if (action.readiness === 'QUEUE_SUBSCRIPTION') {
      const key = subscriptionKey(action, payload);
      const isUnsubscribe = action.event.endsWith(':unsubscribe');
      if (isUnsubscribe) {
        session.subscriptions.delete(key);
      } else {
        if (!session.subscriptions.has(key) && session.subscriptions.size >= MAX_SUBSCRIPTIONS) {
          callback?.({ error: 'Too many remote subscriptions', code: 'REMOTE_BACKPRESSURE' });
          return;
        }
        session.subscriptions.set(key, { action, payload, bytes });
      }
      if (session.state !== 'READY') {
        session.preReadyCount += 1;
        session.preReadyBytes += bytes;
        if (
          session.preReadyCount > MAX_PRE_READY_EVENTS ||
          session.preReadyBytes > MAX_PRE_READY_BYTES
        ) {
          if (!isUnsubscribe) session.subscriptions.delete(key);
          callback?.({ error: 'Remote subscription queue is full', code: 'REMOTE_BACKPRESSURE' });
          return;
        }
        callback?.({ accepted: true, queued: true });
        return;
      }
    } else if (session.state !== 'READY') {
      callback?.({ error: 'Remote WebSocket is not ready', code: 'REMOTE_NOT_READY' });
      return;
    }
    this.sendCommand(session, action, payload, callback);
  }

  private sendCommand(
    session: BridgeSession,
    action: FederatedSocketPolicyAction,
    payload: unknown,
    callback: BrowserAck | null,
  ): void {
    const upstream = session.upstream;
    if (!upstream?.connected || session.state !== 'READY') {
      callback?.({ error: 'Remote WebSocket is not ready', code: 'REMOTE_NOT_READY' });
      return;
    }
    const bytes = jsonBytes(payload);
    if (
      session.pending.size >= MAX_PENDING_MESSAGES ||
      session.pendingBytes + bytes > MAX_PENDING_BYTES
    ) {
      callback?.({ error: 'Remote WebSocket backpressure limit reached', code: 'REMOTE_BACKPRESSURE' });
      this.emitState(session, 'DEGRADED', 'REMOTE_BACKPRESSURE', 1_000);
      return;
    }
    const correlationId = randomUUID();
    const sequence = ++session.outgoingSequence;
    const envelope = validateFederatedWsEnvelope({
      channelId: sessionChannelId(upstream),
      epoch: session.epoch,
      sequence,
      actionId: action.actionId,
      correlationId,
      event: action.event,
      kind: 'EVENT',
      payload,
    });
    const timeout = setTimeout(() => {
      const pending = session.pending.get(correlationId);
      if (!pending) return;
      session.pending.delete(correlationId);
      session.pendingBytes -= pending.bytes;
      pending.callback?.({ error: 'Remote WebSocket acknowledgement timed out', code: 'REMOTE_ACK_TIMEOUT' });
    }, ACK_TIMEOUT_MS);
    timeout.unref();
    session.pending.set(correlationId, { callback, timeout, bytes, sequence });
    session.pendingBytes += bytes;
    upstream.emit('federation:event', envelope);
  }

  private async connect(session: BridgeSession): Promise<void> {
    if (session.closing || !this.sessions.has(session.browser.id)) return;
    this.clearTimer(session, 'reconnectTimer');
    this.clearTimer(session, 'refreshTimer');
    this.closeUpstream(session);
    session.epoch += 1;
    session.outgoingSequence = 0;
    session.incomingSequence = 0;
    this.emitState(session, 'TARGET_CONNECTING', 'TARGET_CONNECTING', null);

    let issued: IssuedFederationWsChannel;
    try {
      issued = await this.issuer.issue({
        targetInstallationId: session.targetInstallationId,
        actor: session.actor,
        browserIp: session.browserIp,
        epoch: session.epoch,
      });
    } catch (error) {
      const code = error instanceof FederationWsIssueError ? error.code : 'REMOTE_NOT_READY';
      if (code === 'REMOTE_NOT_READY') {
        const delay = this.reconnectDelay(session);
        this.emitState(session, 'DEGRADED', code, delay);
        this.scheduleReconnect(session, delay);
      } else {
        this.emitState(session, 'CLOSED', code, null);
        session.browser.emit('proxy:error', { code, message: 'Remote WebSocket authorization failed' });
      }
      return;
    }
    if (session.closing) return;
    session.allowedActionIds = new Set(issued.assertion.actionIds);
    const pinnedAgent = createPinnedSocketAgent(issued.endpoint.wsOrigin, {
      spkiSha256: issued.endpoint.spkiSha256,
      caCertificatePem: issued.endpoint.caCertificatePem,
      connectTimeoutMs: 5_000,
    });
    session.pinnedAgent = pinnedAgent;
    const upstream = io(issued.endpoint.wsOrigin, {
      path: issued.endpoint.wsPath,
      transports: ['websocket'],
      upgrade: false,
      reconnection: false,
      forceNew: true,
      timeout: 10_000,
      agent: pinnedAgent.agent,
      rejectUnauthorized: true,
      auth: { federationChannel: issued.assertion },
    } as unknown as Parameters<typeof io>[1]);
    Object.defineProperty(upstream, '__meowboxFederationChannelId', {
      value: issued.assertion.channelId,
      enumerable: false,
    });
    session.upstream = upstream;
    upstream.on('federation:message', (value: unknown) => this.handleUpstreamMessage(session, value));
    upstream.on('connect_error', () => this.handleUpstreamLoss(session, 'REMOTE_CONNECT_FAILED'));
    upstream.on('disconnect', () => this.handleUpstreamLoss(session, 'REMOTE_DISCONNECTED'));

    const refreshIn = Math.max(
      1_000,
      issued.expiresAt.getTime() - Date.now() - ASSERTION_REFRESH_ADVANCE_MS,
    );
    session.refreshTimer = setTimeout(() => {
      session.refreshTimer = null;
      void this.connect(session);
    }, refreshIn);
    session.refreshTimer.unref();
  }

  private handleUpstreamMessage(session: BridgeSession, value: unknown): void {
    if (session.closing || !session.upstream) return;
    let envelope: FederatedWsEnvelope;
    try {
      envelope = validateFederatedWsEnvelope(value);
    } catch {
      this.failProtocol(session, 'REMOTE_SCHEMA_MISMATCH');
      return;
    }
    if (
      envelope.channelId !== sessionChannelId(session.upstream) ||
      envelope.epoch !== session.epoch ||
      envelope.sequence !== session.incomingSequence + 1
    ) {
      this.failProtocol(session, 'REMOTE_SEQUENCE_INVALID');
      return;
    }
    session.incomingSequence = envelope.sequence;
    if (envelope.kind === 'STATE') {
      if (envelope.actionId !== 'federation.ws-state' || envelope.event !== 'federation:state') {
        this.failProtocol(session, 'REMOTE_ACTION_MISMATCH');
        return;
      }
      let state: FederatedWsStatePayload;
      try { state = validateFederatedWsState(envelope.payload); } catch {
        this.failProtocol(session, 'REMOTE_SCHEMA_MISMATCH');
        return;
      }
      if (!['READY', 'DEGRADED', 'CLOSED'].includes(state.state)) {
        this.failProtocol(session, 'REMOTE_SCHEMA_MISMATCH');
        return;
      }
      this.emitState(session, state.state, state.reasonCode, state.retryAfterMs);
      if (state.state === 'READY') {
        session.reconnectAttempt = 0;
        session.preReadyCount = 0;
        session.preReadyBytes = 0;
        this.replaySubscriptions(session);
      }
      return;
    }
    if (!session.allowedActionIds.has(envelope.actionId)) {
      this.failProtocol(session, 'REMOTE_ACTION_MISMATCH');
      return;
    }
    const action = this.policy.actionById(envelope.actionId);
    if (!action || action.event !== envelope.event) {
      this.failProtocol(session, 'REMOTE_ACTION_MISMATCH');
      return;
    }
    if (envelope.kind === 'ACK' || envelope.kind === 'NACK') {
      let ack: FederatedWsAckPayload;
      try { ack = validateFederatedWsAck(envelope.payload); } catch {
        this.failProtocol(session, 'REMOTE_SCHEMA_MISMATCH');
        return;
      }
      const pending = session.pending.get(envelope.correlationId);
      if (!pending || ack.acceptedSequence !== pending.sequence) {
        this.failProtocol(session, 'REMOTE_ACK_INVALID');
        return;
      }
      clearTimeout(pending.timeout);
      session.pending.delete(envelope.correlationId);
      session.pendingBytes -= pending.bytes;
      pending.callback?.(callbackResult(ack));
      return;
    }
    if (envelope.kind !== 'EVENT' || action.direction !== 'api_to_browser') {
      this.failProtocol(session, 'REMOTE_DIRECTION_INVALID');
      return;
    }
    try {
      this.policy.validatePayload(action, envelope.payload);
    } catch {
      this.failProtocol(session, 'REMOTE_SCHEMA_MISMATCH');
      return;
    }
    session.browser.emit(action.event, envelope.payload);
  }

  private replaySubscriptions(session: BridgeSession): void {
    for (const subscription of session.subscriptions.values()) {
      if (session.allowedActionIds.has(subscription.action.actionId)) {
        this.sendCommand(session, subscription.action, subscription.payload, null);
      }
    }
  }

  private handleUpstreamLoss(session: BridgeSession, reasonCode: string): void {
    if (session.closing || !this.sessions.has(session.browser.id)) return;
    this.closeUpstream(session);
    this.rejectPending(session, 'REMOTE_DISCONNECTED', 'Remote WebSocket disconnected');
    const delay = this.reconnectDelay(session);
    this.emitState(session, 'DEGRADED', reasonCode, delay);
    this.scheduleReconnect(session, delay);
  }

  private failProtocol(session: BridgeSession, reasonCode: string): void {
    this.emitState(session, 'CLOSED', reasonCode, null);
    session.browser.emit('proxy:error', {
      code: reasonCode,
      message: 'Remote WebSocket protocol violation',
    });
    this.detach(session.browser.id);
  }

  private scheduleReconnect(session: BridgeSession, delay = this.reconnectDelay(session)): void {
    if (session.closing || session.reconnectTimer) return;
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      void this.connect(session);
    }, delay);
    session.reconnectTimer.unref();
  }

  private reconnectDelay(session: BridgeSession): number {
    const base = Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * (2 ** session.reconnectAttempt));
    session.reconnectAttempt += 1;
    return Math.max(MIN_RECONNECT_MS, Math.floor(base * (0.75 + Math.random() * 0.5)));
  }

  private emitState(
    session: BridgeSession,
    state: FederatedWsStatePayload['state'],
    reasonCode: string,
    retryAfterMs: number | null,
  ): void {
    session.state = state;
    session.browser.emit('federation:state', {
      state,
      reasonCode,
      readyAt: state === 'READY' ? new Date().toISOString() : null,
      retryAfterMs,
    } satisfies FederatedWsStatePayload);
  }

  private closeUpstream(session: BridgeSession): void {
    const upstream = session.upstream;
    session.upstream = null;
    if (upstream) {
      upstream.removeAllListeners();
      upstream.disconnect();
    }
    session.pinnedAgent?.destroy();
    session.pinnedAgent = null;
  }

  private rejectPending(session: BridgeSession, code: string, message: string): void {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timeout);
      pending.callback?.({ error: message, code });
    }
    session.pending.clear();
    session.pendingBytes = 0;
  }

  private clearTimer(
    session: BridgeSession,
    key: 'reconnectTimer' | 'refreshTimer',
  ): void {
    const timer = session[key];
    if (timer) clearTimeout(timer);
    session[key] = null;
  }
}

function sessionChannelId(socket: UpstreamSocket): string {
  const value = (socket as UpstreamSocket & { __meowboxFederationChannelId?: string })
    .__meowboxFederationChannelId;
  if (!value) throw new Error('Federation channel identity is unavailable');
  return value;
}
