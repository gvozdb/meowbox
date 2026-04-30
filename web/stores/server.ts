import { defineStore } from 'pinia';

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
    // В массиве всегда есть виртуальный main; селект показываем,
    // только когда добавлен хотя бы один slave (length >= 2).
    hasMultipleServers: (state) => state.servers.length >= 2,
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
        const slaves = data || [];
        // Виртуальный main всегда первым, чтобы у юзера в селекте был
        // явный пункт «вернуться на локальный сервер». Сам бэк его не
        // отдаёт (это сама панель), но в UI он нужен наравне со slaves.
        const main: ServerInfo = {
          id: 'main',
          name: 'Этот сервер',
          url: '',
          token: '',
          online: true,
        };
        this.servers = [main, ...slaves];
        // Если выбранный сервер пропал из конфига — откатываемся на main.
        if (!this.servers.find((s) => s.id === this.currentServerId)) {
          this.selectServer('main');
        }
      } catch {
        // Даже при ошибке оставляем main, чтобы UI не разваливался.
        this.servers = [
          { id: 'main', name: 'Этот сервер', url: '', token: '', online: true },
        ];
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
