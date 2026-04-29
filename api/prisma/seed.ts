/**
 * Seed: инициализация админа для свежеустановленной панели.
 *
 * Политика безопасности:
 *   1) Никаких хардкод-паролей. Источники (в порядке приоритета):
 *        a) env MEOWBOX_ADMIN_PASSWORD (установщик/CI сами знают что делают)
 *        b) генерим криптостойкий случайный и ПЕЧАТАЕМ в stdout (чтобы в
 *           консоли установки оператор его увидел и записал).
 *   2) Если админ уже есть — seed пропускает. Повторный запуск на prod
 *      не меняет пароля «случайного» юзера.
 *   3) В NODE_ENV=production запрещаем дефолтный email 'admin@localhost' —
 *      обязываем задать MEOWBOX_ADMIN_EMAIL.
 */

import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

function generatePassword(bytes = 24): string {
  // base64url: безопасно для копирования в терминал/URL, без '=' паддинга.
  return randomBytes(bytes).toString('base64url');
}

async function main() {
  const existingAdmin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
  });

  if (existingAdmin) {
    console.log('Admin user already exists, skipping seed.');
    return;
  }

  const isProd = process.env.NODE_ENV === 'production';
  const username = process.env.MEOWBOX_ADMIN_USERNAME || 'admin';
  const email =
    process.env.MEOWBOX_ADMIN_EMAIL ||
    (isProd ? '' : 'admin@localhost');

  if (!email) {
    console.error(
      'MEOWBOX_ADMIN_EMAIL must be set in production. Refusing to seed with default.',
    );
    process.exit(1);
  }

  const envPassword = process.env.MEOWBOX_ADMIN_PASSWORD;
  const password = envPassword && envPassword.length >= 12 ? envPassword : generatePassword();
  const wasGenerated = !envPassword;

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const admin = await prisma.user.create({
    data: {
      username,
      email,
      passwordHash,
      role: 'ADMIN',
    },
  });

  console.log('─────────────────────────────────────────────────────────');
  console.log(`Admin user created: ${admin.username} (${admin.id})`);
  console.log(`Email:    ${admin.email}`);
  if (wasGenerated) {
    console.log(`Password: ${password}`);
    console.log('IMPORTANT: Record this password now — it will not be shown again.');
    console.log('           Change it after first login.');
  } else {
    console.log('Password: (from MEOWBOX_ADMIN_PASSWORD env)');
  }
  console.log('─────────────────────────────────────────────────────────');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
