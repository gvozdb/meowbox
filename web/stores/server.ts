import { defineStore } from 'pinia';
import type { BrowserRemoteContext } from '@meowbox/shared';
import {
  assertSelectedTargetContext,
  type SelectedTargetSnapshot,
} from '~/utils/selected-target-context';
import { cancelPublicDeliveryRequests } from '~/utils/public-delivery';

interface ServerInfo {
  id: string;
  name: string;
  url: string;
  token: string;
  online: boolean;
  version?: string;
  /** Latest release tag, как видит сам удалённый сервер. */
  latestVersion?: string | null;
  /** Доступно ли обновление панели на удалённом сервере. */
  hasUpdate?: boolean;
  lastCheckedAt?: string;
  lastError?: string;
  federation?: boolean;
  protocolVersion?: number | null;
  activationMode?: string;
  capabilityState?: string;
  reasonCode?: string;
  registryGeneration?: number;
  fleetUpdateReady?: boolean;
  fleetUpdateReason?: string | null;
}

const MAIN_SERVER: Readonly<ServerInfo> = {
  id: 'main',
  name: 'Этот сервер',
  url: '',
  token: '',
  online: true,
};

function nextContextEpoch(): number {
  if (import.meta.server) return 1;
  try {
    const previous = Number.parseInt(sessionStorage.getItem('meowbox-context-epoch') || '0', 10);
    const next = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
    sessionStorage.setItem('meowbox-context-epoch', String(next));
    return next;
  } catch {
    return Date.now();
  }
}

function assertBrowserContext(
  serverId: string,
  value: BrowserRemoteContext,
): BrowserRemoteContext {
  if (
    value.serverId !== serverId ||
    !value.targetInstallationId ||
    !Number.isSafeInteger(value.registryGeneration) ||
    value.registryGeneration < 1 ||
    !Number.isSafeInteger(value.contextEpoch) ||
    value.contextEpoch < 1
  ) {
    throw new Error('Master returned an invalid remote context');
  }
  return value;
}

interface FederationEnrollmentView {
  id: string;
  displayName: string;
  state: string;
  inProgress: boolean;
  reasonCode: string | null;
  attemptCount: number;
  targetInstallationId: string | null;
  remoteServerId: string | null;
}

interface CreateFederationEnrollmentInput {
  displayName: string;
  sshHost: string;
  sshPort: number;
  sshFingerprint: string;
  apiOrigin: string;
  wsOrigin: string;
  wsPath: string;
  browserPublicOrigin: string;
  directTransferOrigin: string;
  spkiSha256: string;
  maxRole: 'ADMIN' | 'MANAGER';
}

export const useServerStore = defineStore('server', {
  state: () => ({
    servers: [] as ServerInfo[],
    currentServerId: 'main',
    registryGeneration: 0,
    contextEpoch: 0,
    remoteContext: null as BrowserRemoteContext | null,
    switching: false,
    selectionInitialized: false,
    loading: false,
  }),

  getters: {
    isLocal: (state) => !state.currentServerId || state.currentServerId === 'main',
    mainServer: () => MAIN_SERVER,
    serverOptions: (state) => [MAIN_SERVER, ...state.servers],
    currentServer: (state) => state.currentServerId === 'main'
      ? MAIN_SERVER
      : state.servers.find((s) => s.id === state.currentServerId),
    hasMultipleServers: (state) => state.servers.length > 0,
  },

  actions: {
    initFromStorage() {
      if (import.meta.server) return;
      if (this.selectionInitialized) return;
      this.selectionInitialized = true;
      this.contextEpoch = nextContextEpoch();
      const saved = localStorage.getItem('meowbox-server');
      if (saved) {
        this.currentServerId = saved;
      }
    },

    beginContextTransition() {
      this.switching = true;
      this.contextEpoch = nextContextEpoch();
      cancelRemoteApiRequests();
      cancelOperationWatches();
      cancelPublicDeliveryRequests();
      try { useSocket().disconnect(); } catch { /* socket may not be initialized */ }
    },

    commitServerSelection(id: string, context: BrowserRemoteContext | null) {
      this.currentServerId = id;
      this.remoteContext = context;
      this.registryGeneration = context?.registryGeneration ?? 0;
      localStorage.setItem('meowbox-server', id);
      this.switching = false;
    },

    async selectServer(id: string) {
      if (id === this.currentServerId || this.switching) return;
      const server = id === 'main' ? MAIN_SERVER : this.servers.find((item) => item.id === id);
      if (!server) throw new Error('Server is no longer present in the master registry');

      this.beginContextTransition();
      try {
        const context = server.federation
          ? assertBrowserContext(
            id,
            await useMasterApi().get<BrowserRemoteContext>(`/servers/${id}/context`),
          )
          : null;
        this.commitServerSelection(id, context);
        try { useSocket().connect(); } catch { /* reconnect is best effort */ }
      } catch (error) {
        this.switching = false;
        try { useSocket().connect(); } catch { /* restore previous channel best effort */ }
        throw error;
      }
    },

    resetToMain(reconnect = false) {
      if (this.currentServerId === 'main' && !this.switching) return;
      this.beginContextTransition();
      this.commitServerSelection('main', null);
      if (reconnect) {
        try { useSocket().connect(); } catch { /* reconnect is best effort */ }
      }
    },

    captureRemoteRequestContext(): SelectedTargetSnapshot | null {
      if (this.currentServerId === 'main') return null;
      if (this.switching) throw new Error('Selected server context is changing');
      const server = this.servers.find((item) => item.id === this.currentServerId);
      if (!server) throw new Error('Selected server is not present in the master registry');
      if (server.federation) {
        const context = this.remoteContext;
        if (!context || context.serverId !== server.id) {
          throw new Error('Federated target context is unavailable');
        }
        if (
          server.registryGeneration !== undefined &&
          server.registryGeneration !== context.registryGeneration
        ) {
          throw new Error('Federated target registry generation changed');
        }
        return {
          serverId: server.id,
          transportServerId: context.targetInstallationId,
          registryGeneration: context.registryGeneration,
          contextEpoch: this.contextEpoch,
        };
      }
      return {
        serverId: server.id,
        transportServerId: server.id,
        registryGeneration: 0,
        contextEpoch: this.contextEpoch,
      };
    },

    isRemoteRequestContextCurrent(expected: SelectedTargetSnapshot): boolean {
      try {
        const current = this.captureRemoteRequestContext();
        return current !== null &&
          current.serverId === expected.serverId &&
          current.transportServerId === expected.transportServerId &&
          current.registryGeneration === expected.registryGeneration &&
          current.contextEpoch === expected.contextEpoch;
      } catch {
        return false;
      }
    },

    captureSelectedTargetContext(): SelectedTargetSnapshot {
      const remote = this.captureRemoteRequestContext();
      return remote ?? {
        serverId: 'main',
        transportServerId: 'main',
        registryGeneration: 0,
        contextEpoch: this.contextEpoch,
      };
    },

    assertSelectedTargetContextCurrent(expected: SelectedTargetSnapshot): void {
      let current: SelectedTargetSnapshot | null = null;
      try {
        current = this.captureSelectedTargetContext();
      } catch {
        current = null;
      }
      assertSelectedTargetContext(expected, current);
    },

    async refreshCurrentRemoteContext() {
      const serverId = this.currentServerId;
      if (serverId === 'main') {
        this.remoteContext = null;
        this.registryGeneration = 0;
        return;
      }
      const server = this.servers.find((item) => item.id === serverId);
      if (!server) throw new Error('Selected server is not present in the master registry');
      if (!server.federation) {
        this.remoteContext = null;
        this.registryGeneration = 0;
        return;
      }
      const context = assertBrowserContext(
        serverId,
        await useMasterApi().get<BrowserRemoteContext>(`/servers/${serverId}/context`),
      );
      if (this.currentServerId !== serverId) return;
      const changed = this.remoteContext !== null &&
        (this.remoteContext.registryGeneration !== context.registryGeneration ||
          this.remoteContext.contextEpoch !== context.contextEpoch ||
          this.remoteContext.targetInstallationId !== context.targetInstallationId);
      if (changed) this.beginContextTransition();
      this.remoteContext = context;
      this.registryGeneration = context.registryGeneration;
      this.switching = false;
      if (changed) {
        try { useSocket().connect(); } catch { /* reconnect is best effort */ }
      }
    },

    async bootstrapSelection() {
      await this.loadServers();
    },

    async loadServers() {
      this.loading = true;
      let refreshContext = false;
      try {
        const api = useMasterApi();
        const data = await api.get<ServerInfo[]>('/servers');
        this.servers = data || [];
        // Если выбранный сервер пропал из конфига — откатываемся на main.
        if (
          this.currentServerId !== 'main' &&
          !this.servers.find((s) => s.id === this.currentServerId)
        ) {
          this.resetToMain(true);
        } else if (this.currentServerId !== 'main') {
          const selected = this.servers.find((s) => s.id === this.currentServerId);
          refreshContext = !!selected?.federation && (
            this.remoteContext === null ||
            selected.registryGeneration !== this.remoteContext.registryGeneration
          );
        }
      } catch {
        this.servers = [];
      } finally {
        this.loading = false;
      }
      if (refreshContext) await this.refreshCurrentRemoteContext();
    },

    async addServer(data: { name: string; url: string; token: string }) {
      const api = useMasterApi();
      const server = await api.post<ServerInfo>('/servers', data);
      await this.loadServers();
      return server;
    },

    async updateServer(id: string, data: { name?: string; url?: string; token?: string }) {
      const api = useMasterApi();
      const server = await api.put<ServerInfo>(`/servers/${id}`, data);
      await this.loadServers();
      return server;
    },

    async deleteServer(id: string) {
      const api = useMasterApi();
      await api.del(`/servers/${id}`);
      await this.loadServers();
    },

    async createFederationEnrollment(data: CreateFederationEnrollmentInput) {
      const api = useMasterApi();
      return api.post<FederationEnrollmentView>('/servers/enrollments', data);
    },

    async resumeFederationEnrollment(id: string, sshPassword: string) {
      const api = useMasterApi();
      return api.post<FederationEnrollmentView>(
        `/servers/enrollments/${id}/resume`,
        { sshPassword },
      );
    },

    async cancelFederationEnrollment(id: string) {
      const api = useMasterApi();
      return api.post<FederationEnrollmentView>(`/servers/enrollments/${id}/cancel`);
    },
  },
});
