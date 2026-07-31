import { encryptWithDomain, decryptWithDomain } from './master-key';

/**
 * Шифратор для `SiteDomain.cmsAdminPasswordEnc` — пароль админки CMS.
 *
 * До унификации (spec 2026-05-10) пароль хранился plain в
 * legacy `Site.cmsAdminPassword`. Историческая миграция переносит
 * plain → enc, обнуляя старое поле.
 *
 * Формат: AES-256-GCM, derived через HKDF(master, 'meowbox:cms:v1').
 */

export function encryptCmsPassword(plain: string): string {
  return encryptWithDomain('cms', { password: plain });
}

export function decryptCmsPassword(encoded: string): string {
  const obj = decryptWithDomain<{ password: string }>('cms', encoded);
  if (!obj?.password) throw new Error('Decrypted CMS password is empty');
  return obj.password;
}
