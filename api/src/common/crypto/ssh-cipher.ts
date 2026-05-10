import { encryptWithDomain, decryptWithDomain } from './master-key';

/**
 * Шифратор для `Site.sshPasswordEnc` — пароль SSH/SFTP линукс-юзера сайта.
 *
 * До унификации (spec 2026-05-10) пароль хранился plain в `Site.sshPassword`.
 * Миграция `2026-05-10-002-rekey-secrets` переносит plain → enc, обнуляя старое
 * поле. См. docs/specs/2026-05-10-master-key-unification.md §4.3.
 *
 * Формат: AES-256-GCM, derived через HKDF(master, 'meowbox:ssh:v1').
 */

export function encryptSshPassword(plain: string): string {
  return encryptWithDomain('ssh', { password: plain });
}

export function decryptSshPassword(encoded: string): string {
  const obj = decryptWithDomain<{ password: string }>('ssh', encoded);
  if (!obj?.password) throw new Error('Decrypted SSH password is empty');
  return obj.password;
}
