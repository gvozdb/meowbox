import { io, Socket } from 'socket.io-client';

interface SystemMetrics {
  cpuPercent: number;
  memoryPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  diskPercent: number;
  diskUsed: number;
  diskTotal: number;
  networkRx: number;
  networkTx: number;
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
/**
 * id slave-сервера, к которому привязан текущий socket. Если null — socket
 * соединён с локальным мастером. При смене активного сервера в сайдбаре мы
 * закрываем существующий socket и переоткрываем с новым auth.proxyServerId
 * (см. ensureSocketForCurrentServer).
 */
let socketBoundServerId: string | null = null;
const pendingListeners: Array<{ event: string; callback: Function }> = [];

/** Register a socket listener, queuing it if the socket isn't connected yet */
function registerListener(event: string, callback: Function): () => void {
  if (socket) {
    socket.on(event, callback as never);
  } else {
    pendingListeners.push({ event, callback });
  }
  return () => {
    socket?.off(event, callback as never);
    const idx = pendingListeners.findIndex(p => p.event === event && p.callback === callback);
    if (idx >= 0) pendingListeners.splice(idx, 1);
  };
}

export function useSocket() {
  const config = useRuntimeConfig();
  const metrics = useState<SystemMetrics | null>('ws-metrics', () => null);
  const connected = useState<boolean>('ws-connected', () => false);

  function isRemoteServer(): boolean {
    try {
      const serverStore = useServerStore();
      return !serverStore.isLocal;
    } catch {
      return false;
    }
  }

  function getActiveServerId(): string | null {
    try {
      const serverStore = useServerStore();
      // isLocal === true означает, что выбран master ('main') — сокет идёт в локальный мастер.
      if (serverStore.isLocal) return null;
      return serverStore.currentServerId || null;
    } catch {
      return null;
    }
  }

  function connect() {
    const targetServerId = getActiveServerId();

    // Если сокет уже подключён И привязан к нужному серверу — ничего не делаем.
    if (socket?.connected && socketBoundServerId === targetServerId) return;

    // Если сокет существует, но привязан к другому серверу — переоткрываем.
    if (socket && socketBoundServerId !== targetServerId) {
      try { socket.disconnect(); } catch { /* noop */ }
      socket = null;
      connected.value = false;
    }

    const token = localStorage.getItem('accessToken');
    if (!token) return;

    const apiBase = config.public.apiBase as string;
    // Extract base URL (protocol + host) from apiBase
    const url = apiBase.replace(/\/api\/?$/, '');

    // При выбранном slave-сервере шлём proxyServerId — мастер откроет upstream
    // socket к slave и прозрачно ретранслирует все события в обе стороны.
    // Это разблокирует terminal/logs-tail/AI/deploy-log/backup-progress/
    // site-provision/php-install/migrate-hostpanel на удалённых серверах.
    const auth: Record<string, string> = { token };
    if (targetServerId) auth.proxyServerId = targetServerId;

    socket = io(url, {
      auth,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 5000,
    });
    socketBoundServerId = targetServerId;

    // Replay listeners that were registered before the socket was created
    for (const { event, callback } of pendingListeners) {
      socket.on(event, callback as never);
    }
    pendingListeners.length = 0;

    socket.on('connect', () => {
      connected.value = true;
    });

    socket.on('disconnect', () => {
      connected.value = false;
    });

    // Если мастер не смог достучаться до slave — закрываем сокет и кидаем
    // toast (proxy:error прилетает один раз в начале сессии).
    socket.on('proxy:error', (payload: { code?: string; message?: string }) => {
      // eslint-disable-next-line no-console
      console.warn('[useSocket] proxy error:', payload);
    });

    // System metrics stream (every 10s) — на remote мастер ретранслирует метрики slave'а
    // (после WS-прокси), на local — приходят от агента мастера.
    socket.on('system:metrics', (data: SystemMetrics) => {
      metrics.value = data;
    });
  }

  function disconnect() {
    if (socket) {
      socket.disconnect();
      socket = null;
      socketBoundServerId = null;
      connected.value = false;
    }
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
      if (!socket?.connected) {
        reject(new Error('Socket not connected'));
        return;
      }
      const cb = (response: { sessionId?: string; error?: string }) => {
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve({ sessionId: response.sessionId! });
        }
      };
      if (user) {
        socket.emit('terminal:open', { user }, cb);
      } else {
        socket.emit('terminal:open', cb);
      }
    });
  }

  function terminalInput(sessionId: string, data: string) {
    socket?.emit('terminal:input', { sessionId, data });
  }

  function terminalResize(sessionId: string, cols: number, rows: number) {
    socket?.emit('terminal:resize', { sessionId, cols, rows });
  }

  function terminalClose(sessionId: string) {
    socket?.emit('terminal:close', { sessionId });
  }

  function onTerminalData(callback: (payload: { sessionId: string; data: string }) => void) {
    return registerListener('terminal:data', callback);
  }

  // --- Log Tail ---

  function logsTailStart(source: string, type: string): Promise<{ tailId: string }> {
    return new Promise((resolve, reject) => {
      if (!socket?.connected) {
        reject(new Error('Socket not connected'));
        return;
      }
      socket.emit('logs:tail:start', { source, type }, (response: { tailId?: string; error?: string }) => {
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve({ tailId: response.tailId! });
        }
      });
    });
  }

  function logsTailStop(tailId: string) {
    socket?.emit('logs:tail:stop', { tailId });
  }

  function onLogsTailData(callback: (payload: { tailId: string; line: string }) => void) {
    return registerListener('logs:tail:data', callback);
  }

  // --- AI Chat ---

  function aiStart(prompt: string, options?: { cwd?: string; sessionId?: string }) {
    socket?.emit('ai:start', { prompt, cwd: options?.cwd, sessionId: options?.sessionId });
  }

  function aiMessage(sessionId: string, message: string) {
    socket?.emit('ai:message', { sessionId, message });
  }

  function aiStop() {
    socket?.emit('ai:stop');
  }

  function onAiEvent(eventType: string, callback: (payload: Record<string, unknown>) => void) {
    return registerListener(`ai:${eventType}`, callback);
  }

  return {
    connect,
    disconnect,
    metrics,
    connected,
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
    getSocket: () => socket,
  };
}
