import { defineStore } from 'pinia';

interface ServerInfo {
  id: string;
  name: string;
  url: string;
  token: string;
  online: boolean;
  version?: string;
}

export const useServerStore = defineStore('server', {
  state: () => ({
    servers: [] as ServerInfo[],
    currentServerId: 'main',
    loading: false,
  }),

  getters: {
    isLocal: (state) => !state.currentServerId || state.currentServerId === 'main',
    currentServer: (state) => state.servers.find((s) => s.id === state.currentServerId),
    hasMultipleServers: (state) => state.servers.length > 1,
  },

  actions: {
    initFromStorage() {
      if (import.meta.server) return;
      const saved = localStorage.getItem('meowbox-server');
      if (saved) {
        this.currentServerId = saved;
      }
    },

    selectServer(id: string) {
      this.currentServerId = id;
      localStorage.setItem('meowbox-server', id);
    },

    async loadServers() {
      this.loading = true;
      try {
        const api = useApi();
        const data = await api.get<ServerInfo[]>('/servers');
        this.servers = data || [];
        // If current server no longer exists in config, reset to main
        if (this.servers.length > 0 && !this.servers.find((s) => s.id === this.currentServerId)) {
          this.selectServer(this.servers[0].id);
        }
      } catch {
        this.servers = [];
      } finally {
        this.loading = false;
      }
    },

    async addServer(data: { name: string; url: string; token: string }) {
      const api = useApi();
      const server = await api.post<ServerInfo>('/servers', data);
      await this.loadServers();
      return server;
    },

    async updateServer(id: string, data: { name?: string; url?: string; token?: string }) {
      const api = useApi();
      const server = await api.put<ServerInfo>(`/servers/${id}`, data);
      await this.loadServers();
      return server;
    },

    async deleteServer(id: string) {
      const api = useApi();
      await api.del(`/servers/${id}`);
      await this.loadServers();
    },

    async provisionServer(data: { name: string; host: string; port?: number; password: string }) {
      const api = useApi();
      return api.post<{ server: ServerInfo; online: boolean; version?: string; logs: string[] }>(
        '/servers/provision',
        data,
      );
    },
  },
});
