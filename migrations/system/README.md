# System migrations

Здесь живут **системные миграции** — операции над состоянием сервера (файлы на диске, юзеры ОС, регенерация конфигов, изменения в `state/.env`, side effects от смены ecosystem.config.js).

**Не путать с Prisma migrations** в `api/prisma/migrations/` — те правят схему БД, эти правят всё остальное.

## Когда писать миграцию

Перед коммитом фичи отвечай на вопросы. Хоть один «да» — нужна миграция.

1. Менял шаблоны nginx / php-fpm / logrotate / cron / systemd? → regenerate всех существующих сайтов.
2. Переименовывал/двигал файлы или директории на диске сервера?
3. Добавил новую env-переменную в `state/.env`?
4. Менял состояние ОС (`useradd`, `pm2 delete`, `systemctl enable`)?

## Создание

```bash
bash tools/new-migration.sh <slug>
```

→ создаёт файл `migrations/system/<YYYY-MM-DD>-<NNN>-<slug>.ts` с заготовкой.

## Контракт

```ts
import type { SystemMigration } from './_types';

export const migration: SystemMigration = {
  id: '2026-04-29-001-rename-public-to-www',
  description: 'Переименовать www-каталоги сайтов с public/ на www/',

  async preflight(ctx) {
    // optional: проверить что условия выполнения миграции соблюдены
    // (например: «нужны права root» или «restic должен быть установлен»).
    return { ok: true };
  },

  async up(ctx) {
    // Главная логика. ОБЯЗАТЕЛЬНО идемпотентная:
    // повторный запуск после падения в середине не должен ломать систему.
    const sites = await ctx.prisma.site.findMany();
    for (const site of sites) {
      const oldPath = `${site.rootPath}/public`;
      const newPath = `${site.rootPath}/www`;
      if (await ctx.exists(newPath)) continue;          // уже сделано
      if (!(await ctx.exists(oldPath))) continue;       // нечего двигать
      await ctx.exec.run('mv', [oldPath, newPath]);
      ctx.log(`renamed ${oldPath} → ${newPath}`);
    }
  },

  // optional: ручной откат, если миграция оставила систему в полу-применённом состоянии
  async down(ctx) {
    // ...
  },
};

export default migration;
```

## Применение

Автоматически дёргается при `make update` после `prisma migrate deploy`.

Ручной запуск:
```bash
make migrate-system          # apply pending
node migrations/runner.js status   # список pending/applied
```

## Правила

1. **Идемпотентность обязательна.** Проверяй текущее состояние перед изменением.
2. **Один файл = одно атомарное изменение.** Не сваливай несвязанные операции в одну миграцию.
3. **Никогда не изменяй уже применённую миграцию.** Чексум не сойдётся, runner покажет warning. Если нужно — пиши новую миграцию-фикс.
4. **`id` миграции должен быть уникальным и сортируемым.** Формат: `<YYYY-MM-DD>-<NNN>-<slug>`. NNN — порядковый номер за день.
5. **Ошибки явные.** Не глотай исключения — runner поймает, запишет в БД с `ok=false`, обновление откатится.
