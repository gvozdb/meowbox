import { io, Socket } from 'socket.io-client';
import type {
  FederatedWsState,
  FederatedWsStatePayload,
} from '@meowbox/shared';

interface SystemMetricsEnvelope {
  serverId: string;
  data: unknown;
}

interface SiteStatusPayload {
  siteId: string;
  status: string;
  previousStatus: string;
  timestamp: string;
}

interface DeployLogPayload {
  deployLogId: string;
  line: string;
  stream: 'stdout' | 'stderr';
  timestamp: string;
}

interface BackupProgressPayload {
  backupId: string;
  progress: number;
  status?: string;
  timestamp: string;
}

interface SiteProvisionLogPayload {
  siteId: string;
  level: 'info' | 'warn' | 'error';
  line: string;
  timestamp: string;
}

interface SiteProvisionDonePayload {
  siteId: string;
  status: 'RUNNING' | 'ERROR';
  error?: string;
  timestamp: string;
}

let socket: Socket | null = null;
let socketBoundContextKey: string | null = null;

interface SocketBinding {
  contextKey: string;
  eventServerId: string;
  proxyServerId: string | null;
}

interface RegisteredListener {
  event: string;
  callback: Function;
  attachedSocket: Socket | null;
  wrapped: Function | null;
}

const registeredListeners = new Set<RegisteredListener>();

function currentSocketBinding(): SocketBinding {
  const serverStore = useServerStore();
  if (serverStore.isLocal) {
    return {
      contextKey: `main:0:${serverStore.contextEpoch}`,
      eventServerId: 'main',
      proxyServerId: null,
    };
  }
  const context = serverStore.captureRemoteRequestContext();
  if (!context) throw new Error('Selected target context is unavailable');
  return {
    contextKey: [
      context.serverId,
      context.transportServerId,
      context.registryGeneration,
      context.contextEpoch,
    ].join(':'),
    eventServerId: context.serverId,
    proxyServerId: context.transportServerId,
  };
}

function contextKeyIsCurrent(expected: string): boolean {
  try {
    return currentSocketBinding().contextKey === expected;
  } catch {
    return false;
  }
}

function attachListener(entry: RegisteredListener, target: Socket, contextKey: string): void {
  if (entry.attachedSocket === target) return;
  if (entry.attachedSocket && entry.wrapped) {
    entry.attachedSocket.off(entry.event, entry.wrapped as never);
  }
  const wrapped = (...args: unknown[]) => {
    if (
      socket !== target ||
      socketBoundContextKey !== contextKey ||
      !contextKeyIsCurrent(contextKey)
    ) return;
    entry.callback(...args);
  };
  entry.attachedSocket = target;
  entry.wrapped = wrapped;
  target.on(entry.event, wrapped as never);
}

function detachListeners(target: Socket): void {
  for (const entry of registeredListeners) {
    if (entry.attachedSocket !== target || !entry.wrapped) continue;
    target.off(entry.event, entry.wrapped as never);
    entry.attachedSocket = null;
    entry.wrapped = null;
  }
}

/** Listener registrations survive a context-safe socket rebind. */
function registerListener(event: string, callback: Function): () => void {
  const entry: RegisteredListener = {
    event,
    callback,
    attachedSocket: null,
    wrapped: null,
  };
  registeredListeners.add(entry);
  if (socket && socketBoundContextKey) attachListener(entry, socket, socketBoundContextKey);
  return () => {
    if (entry.attachedSocket && entry.wrapped) {
      entry.attachedSocket.off(entry.event, entry.wrapped as never);
    }
    registeredListeners.delete(entry);
  };
}

export function useSocket() {
  const config = useRuntimeConfig();
  const metrics = useState<SystemMetricsEnvelope | null>('ws-metrics', () => null);
  const connected = useState<boolean>('ws-connected', () => false);
  const federationState = useState<FederatedWsState>('ws-federation-state', () => 'CLOSED');
  const federationReason = useState<string>('ws-federation-reason', () => 'NOT_CONNECTED');
  const ready = computed(() => federationState.value === 'READY');

  function setFederationState(payload: FederatedWsStatePayload): void {
    federationState.value = payload.state;
    federationReason.value = payload.reasonCode;
  }

  function connect() {
    const binding = currentSocketBinding();

    if (socket && socketBoundContextKey === binding.contextKey) {
      if (!socket.connected) socket.connect();
      return;
    }

    disconnect();

    const token = localStorage.getItem('accessToken');
    if (!token) return;

    setFederationState({
      state: binding.proxyServerId ? 'TARGET_CONNECTING' : 'MASTER_CONNECTED',
      reasonCode: binding.proxyServerId ? 'REMOTE_NOT_READY' : 'CONNECTING',
      readyAt: null,
      retryAfterMs: null,
    });

    const apiBase = config.public.apiBase as string;
    // Extract base URL (protocol + host) from apiBase
    const url = apiBase.replace(/\/api\/?$/, '');

    // При выбранном slave-сервере шлём proxyServerId — мастер откроет upstream
    // socket к slave и прозрачно ретранслирует все события в обе стороны.
    // Это разблокирует terminal/logs-tail/AI/deploy-log/backup-progress/
    // site-provision/php-install/migrate-hostpanel на удалённых серверах.
    const auth: Record<string, string> = { token };
    if (binding.proxyServerId) auth.proxyServerId = binding.proxyServerId;

    const created = io(url, {
      auth,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 5000,
    });
    socket = created;
    socketBoundContextKey = binding.contextKey;

    for (const entry of registeredListeners) {
      attachListener(entry, created, binding.contextKey);
    }

    created.on('connect', () => {
      if (socket !== created || !contextKeyIsCurrent(binding.contextKey)) return;
      connected.value = true;
      setFederationState({
        state: binding.proxyServerId ? 'MASTER_CONNECTED' : 'READY',
        reasonCode: binding.proxyServerId ? 'TARGET_CONNECTING' : 'READY',
        readyAt: binding.proxyServerId ? null : new Date().toISOString(),
        retryAfterMs: null,
      });
    });

    created.on('disconnect', () => {
      if (socket !== created) return;
      connected.value = false;
      setFederationState({
        state: 'CLOSED',
        reasonCode: 'MASTER_DISCONNECTED',
        readyAt: null,
        retryAfterMs: null,
      });
    });

    created.on('federation:state', (payload: FederatedWsStatePayload) => {
      if (
        socket !== created ||
        !contextKeyIsCurrent(binding.contextKey) ||
        !binding.proxyServerId ||
        !payload ||
        !['MASTER_CONNECTED', 'TARGET_CONNECTING', 'READY', 'DEGRADED', 'CLOSED'].includes(payload.state)
      ) return;
      setFederationState(payload);
    });

    // Если мастер не смог достучаться до slave — закрываем сокет и кидаем
    // toast (proxy:error прилетает один раз в начале сессии).
    created.on('proxy:error', (payload: { code?: string; message?: string }) => {
      if (socket !== created || !contextKeyIsCurrent(binding.contextKey)) return;
      setFederationState({
        state: payload.code === 'REMOTE_WS_UPGRADE_REQUIRED' ? 'CLOSED' : 'DEGRADED',
        reasonCode: payload.code || 'REMOTE_NOT_READY',
        readyAt: null,
        retryAfterMs: null,
      });
      // eslint-disable-next-line no-console
      console.warn('[useSocket] proxy error:', payload);
    });

    // System metrics stream (every 10s) — на remote мастер ретранслирует метрики slave'а
    // (после WS-прокси), на local — приходят от агента мастера.
    created.on('system:metrics', (data: unknown) => {
      if (socket !== created || !contextKeyIsCurrent(binding.contextKey)) return;
      metrics.value = { serverId: binding.eventServerId, data };
    });
  }

  function disconnect() {
    if (socket) {
      const previous = socket;
      detachListeners(previous);
      previous.disconnect();
      socket = null;
      socketBoundContextKey = null;
      connected.value = false;
      federationState.value = 'CLOSED';
      federationReason.value = 'DISCONNECTED';
    }
  }

  function contextSocket(): Socket | null {
    if (
      !socket ||
      !socketBoundContextKey ||
      !contextKeyIsCurrent(socketBoundContextKey)
    ) {
      return null;
    }
    return socket;
  }

  function activeSocket(): Socket | null {
    return federationState.value === 'READY' ? contextSocket() : null;
  }

  function onSiteStatus(callback: (payload: SiteStatusPayload) => void) {
    return registerListener('site:status', callback);
  }

  function onDeployLog(callback: (payload: DeployLogPayload) => void) {
    return registerListener('site:deploy:log', callback);
  }

  function onBackupProgress(callback: (payload: BackupProgressPayload) => void) {
    return registerListener('backup:progress', callback);
  }

  function onBackupRestoreProgress(callback: (payload: BackupProgressPayload & { error?: string }) => void) {
    return registerListener('backup:restore:progress', callback);
  }

  function onSiteProvisionLog(callback: (payload: SiteProvisionLogPayload) => void) {
    return registerListener('site:provision:log', callback);
  }

  function onSiteProvisionDone(callback: (payload: SiteProvisionDonePayload) => void) {
    return registerListener('site:provision:done', callback);
  }

  // --- Terminal ---

  function terminalOpen(user?: string): Promise<{ sessionId: string }> {
    return new Promise((resolve, reject) => {
      const target = activeSocket();
      const expectedContext = socketBoundContextKey;
      if (!target?.connected || !expectedContext) {
        reject(new Error('Socket not connected'));
        return;
      }
      const cb = (response: { sessionId?: string; error?: string }) => {
        if (target !== activeSocket() || !contextKeyIsCurrent(expectedContext)) {
          reject(new Error('Selected server changed before terminal opened'));
          return;
        }
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve({ sessionId: response.sessionId! });
        }
      };
      if (user) {
        target.emit('terminal:open', { user }, cb);
      } else {
        target.emit('terminal:open', cb);
      }
    });
  }

  function terminalInput(sessionId: string, data: string) {
    activeSocket()?.emit('terminal:input', { sessionId, data });
  }

  function terminalResize(sessionId: string, cols: number, rows: number) {
    activeSocket()?.emit('terminal:resize', { sessionId, cols, rows });
  }

  function terminalClose(sessionId: string) {
    activeSocket()?.emit('terminal:close', { sessionId });
  }

  function onTerminalData(callback: (payload: { sessionId: string; data: string }) => void) {
    return registerListener('terminal:data', callback);
  }

  // --- Log Tail ---

  function logsTailStart(source: string, type: string): Promise<{ tailId: string }> {
    return new Promise((resolve, reject) => {
      const target = activeSocket();
      const expectedContext = socketBoundContextKey;
      if (!target?.connected || !expectedContext) {
        reject(new Error('Socket not connected'));
        return;
      }
      target.emit('logs:tail:start', { source, type }, (response: { tailId?: string; error?: string }) => {
        if (target !== activeSocket() || !contextKeyIsCurrent(expectedContext)) {
          reject(new Error('Selected server changed before log tail opened'));
          return;
        }
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve({ tailId: response.tailId! });
        }
      });
    });
  }

  function logsTailStop(tailId: string) {
    activeSocket()?.emit('logs:tail:stop', { tailId });
  }

  function onLogsTailData(callback: (payload: { tailId: string; line: string }) => void) {
    return registerListener('logs:tail:data', callback);
  }

  // --- AI Chat ---

  function aiStart(prompt: string, options?: { cwd?: string; sessionId?: string }) {
    activeSocket()?.emit('ai:start', { prompt, cwd: options?.cwd, sessionId: options?.sessionId });
  }

  function aiMessage(sessionId: string, message: string) {
    activeSocket()?.emit('ai:message', { sessionId, message });
  }

  function aiStop() {
    activeSocket()?.emit('ai:stop');
  }

  function onAiEvent(eventType: string, callback: (payload: Record<string, unknown>) => void) {
    return registerListener(`ai:${eventType}`, callback);
  }

  return {
    connect,
    disconnect,
    metrics,
    connected,
    ready,
    federationState,
    federationReason,
    onSiteStatus,
    onDeployLog,
    onBackupProgress,
    onBackupRestoreProgress,
    onSiteProvisionLog,
    onSiteProvisionDone,
    terminalOpen,
    terminalInput,
    terminalResize,
    terminalClose,
    onTerminalData,
    logsTailStart,
    logsTailStop,
    onLogsTailData,
    aiStart,
    aiMessage,
    aiStop,
    onAiEvent,
    getSocket: contextSocket,
  };
}
