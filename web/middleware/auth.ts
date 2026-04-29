/**
 * Auth middleware — проверяет access-токен перед открытием страниц.
 *
 * Важно: валидируем **exp** из JWT-payload (client-side, без запроса к API),
 * чтобы просроченные токены не пропускали на страницы и не давали UI
 * отрисовать закэшированные данные до того, как первый запрос к API
 * вернёт 401 и триггернёт редирект.
 *
 * Если access-токен просрочен, но есть refresh-токен — пропускаем страницу
 * (useApi сам обновит токен на первом же запросе). Если refresh тоже нет
 * или тоже просрочен — на /login.
 */
function decodeJwtPayload(token: string): { exp?: number } | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    // base64url → base64
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(payload.length + (4 - payload.length % 4) % 4, '=');
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

function isExpired(token: string | null): boolean {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return true;
  // expiry с запасом 5 секунд (защита от clock skew)
  return payload.exp * 1000 < Date.now() - 5000;
}

export default defineNuxtRouteMiddleware((to) => {
  const publicPages = ['/login', '/setup'];
  if (publicPages.includes(to.path)) return;

  if (import.meta.client) {
    const access = localStorage.getItem('accessToken');
    const refresh = localStorage.getItem('refreshToken');

    // Нет вообще ничего — на логин.
    if (!access && !refresh) {
      return navigateTo('/login');
    }

    // Access протух, refresh тоже протух → на логин (чистим localStorage).
    if (isExpired(access) && isExpired(refresh)) {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      return navigateTo('/login');
    }

    // Access протух, refresh жив — пропускаем, useApi обновит на первом запросе.
    // Access жив — пропускаем.
  }
});
