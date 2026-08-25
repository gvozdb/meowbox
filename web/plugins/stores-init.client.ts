/**
 * Инициализирует Pinia-сторы из localStorage **до** монтирования страниц.
 *
 * Без этого был баг: `default.vue` зовёт `serverStore.initFromStorage()` в
 * своём onMounted — но layout это родитель `<NuxtPage />`, а в Vue child
 * mounted срабатывает РАНЬШЕ parent mounted. Поэтому страница (`pages/sites`,
 * `pages/databases` и т.п.) успевала отправить `api.get('/sites')` с
 * дефолтным `currentServerId = 'main'`, и юзер видел данные мастера, хотя
 * в localStorage уже сохранён slave.
 *
 * Плагин (.client.ts) выполняется до рендера приложения, так что любой
 * onMounted ниже уже видит правильный currentServerId/токены.
 */
import { useAuthStore } from '../stores/auth';
import { useServerStore } from '../stores/server';

export default defineNuxtPlugin(async () => {
  if (import.meta.server) return;
  const authStore = useAuthStore();
  const serverStore = useServerStore();
  try {
    authStore.initFromStorage();
  } catch { /* store can throw if pinia not ready — ignore, layout fallback */ }
  try {
    serverStore.initFromStorage();
  } catch { /* как выше */ }
  if (authStore.accessToken) {
    try {
      await serverStore.bootstrapSelection();
    } catch {
      // Selected target remains fail-closed; layout surfaces normal request errors.
    }
  }
});
