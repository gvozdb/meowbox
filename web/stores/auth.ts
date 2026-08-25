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

const LOGOUT_REVOCATION_UNCERTAIN_KEY = 'meowbox.logout-revocation-uncertain';

function persistLogoutRevocationState(uncertain: boolean) {
  if (import.meta.server) return;
  try {
    if (uncertain) {
      sessionStorage.setItem(LOGOUT_REVOCATION_UNCERTAIN_KEY, '1');
    } else {
      sessionStorage.removeItem(LOGOUT_REVOCATION_UNCERTAIN_KEY);
    }
  } catch { /* storage can be unavailable */ }
}

function resetRemoteSelectionAndTransport() {
  cancelRemoteApiRequests();
  cancelOperationWatches();
  try { useSocket().disconnect(); } catch { /* client transport may not be initialized */ }
  const serverStore = useServerStore();
  serverStore.resetToMain();
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as AuthUser | null,
    accessToken: null as string | null,
    logoutRevocationUncertain: false,
  }),

  getters: {
    isAuthenticated: (state) => !!state.accessToken,
    isAdmin: (state) => state.user?.role === 'ADMIN',
  },

  actions: {
    async login(username: string, password: string) {
      resetRemoteSelectionAndTransport();
      this.logoutRevocationUncertain = false;
      persistLogoutRevocationState(false);
      const api = useMasterApi();
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
      const api = useMasterApi();
      const user = await api.get<AuthUser>('/auth/me');
      this.user = user;
    },

    async logout() {
      let revocationConfirmed = true;
      try {
        const api = useMasterApi();
        const refreshToken = localStorage.getItem('refreshToken');
        if (refreshToken) {
          await api.post('/auth/logout', { refreshToken });
        }
      } catch {
        revocationConfirmed = false;
      } finally {
        resetRemoteSelectionAndTransport();
        this.accessToken = null;
        this.user = null;
        this.logoutRevocationUncertain = !revocationConfirmed;
        persistLogoutRevocationState(!revocationConfirmed);
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        navigateTo('/login');
      }
      return { revocationConfirmed };
    },

    initFromStorage() {
      if (import.meta.server) return;
      const token = localStorage.getItem('accessToken');
      try {
        this.logoutRevocationUncertain = sessionStorage.getItem(LOGOUT_REVOCATION_UNCERTAIN_KEY) === '1';
      } catch { /* storage can be unavailable */ }
      if (token) {
        this.accessToken = token;
      }
    },
  },
});
