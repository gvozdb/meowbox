import { defineStore } from 'pinia';

interface AuthUser {
  id: string;
  username: string;
  email: string;
  role: string;
  totpEnabled: boolean;
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as AuthUser | null,
    accessToken: null as string | null,
  }),

  getters: {
    isAuthenticated: (state) => !!state.accessToken,
    isAdmin: (state) => state.user?.role === 'ADMIN',
  },

  actions: {
    async login(username: string, password: string) {
      const api = useApi();
      const data = await api.publicPost<LoginResponse>('/auth/login', {
        username,
        password,
      });

      this.accessToken = data.accessToken;
      this.user = data.user;

      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
    },

    async fetchProfile() {
      const api = useApi();
      const user = await api.get<AuthUser>('/auth/me');
      this.user = user;
    },

    async logout() {
      try {
        const api = useApi();
        const refreshToken = localStorage.getItem('refreshToken');
        if (refreshToken) {
          await api.post('/auth/logout', { refreshToken });
        }
      } catch {
        // Logout request failed — clear locally anyway
      }

      this.accessToken = null;
      this.user = null;
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      navigateTo('/login');
    },

    initFromStorage() {
      if (import.meta.server) return;
      const token = localStorage.getItem('accessToken');
      if (token) {
        this.accessToken = token;
      }
    },
  },
});
