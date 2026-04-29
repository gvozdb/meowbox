#!/usr/bin/env bash
# =============================================================================
# Создаёт заготовку системной миграции: migrations/system/<YYYY-MM-DD>-<NNN>-<slug>.ts
#
# Usage:
#   bash tools/new-migration.sh <slug>
#
# Пример:
#   bash tools/new-migration.sh rename-public-to-www
#   → migrations/system/2026-04-29-001-rename-public-to-www.ts
# =============================================================================
set -euo pipefail

SLUG="${1:-}"
if [[ -z "$SLUG" ]]; then
  echo "Usage: bash tools/new-migration.sh <slug>" >&2
  echo "  slug: kebab-case-описание (напр. rename-public-to-www)" >&2
  exit 2
fi
if [[ ! "$SLUG" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "Slug должен быть kebab-case: только [a-z0-9-], начинаться с буквы" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$SCRIPT_DIR")"
SYSTEM_DIR="$PANEL_DIR/migrations/system"
mkdir -p "$SYSTEM_DIR"

DATE="$(date +%Y-%m-%d)"
# Поиск максимального NNN за сегодня
MAX_N=0
for f in "$SYSTEM_DIR"/${DATE}-*.ts; do
  [[ -e "$f" ]] || continue
  base="$(basename "$f" .ts)"
  n="$(echo "$base" | awk -F- '{print $4}')"
  [[ "$n" =~ ^[0-9]+$ ]] || continue
  (( n > MAX_N )) && MAX_N=$n
done
NEXT_N="$(printf '%03d' $((MAX_N + 1)))"
ID="${DATE}-${NEXT_N}-${SLUG}"
FILE="$SYSTEM_DIR/${ID}.ts"

if [[ -e "$FILE" ]]; then
  echo "Файл уже существует: $FILE" >&2
  exit 1
fi

cat > "$FILE" <<EOF
import type { SystemMigration } from './_types';

const migration: SystemMigration = {
  id: '${ID}',
  description: 'TODO: одной строкой что делает миграция',

  // async preflight(ctx) {
  //   if (!(await ctx.exists('/usr/bin/restic'))) {
  //     return { ok: false, reason: 'restic не установлен' };
  //   }
  //   return { ok: true };
  // },

  async up(ctx) {
    // ИДЕМПОТЕНТНОСТЬ ОБЯЗАТЕЛЬНА. Проверяй текущее состояние перед изменением.
    // Пример:
    //   const sites = await ctx.prisma.site.findMany();
    //   for (const site of sites) {
    //     if (await ctx.exists(\`\${site.rootPath}/www\`)) continue;  // already done
    //     await ctx.exec.run('mv', [\`\${site.rootPath}/public\`, \`\${site.rootPath}/www\`]);
    //     ctx.log(\`renamed \${site.name}\`);
    //   }
    throw new Error('TODO: implement up()');
  },

  // async down(ctx) {
  //   // Опциональный откат. Вызывается вручную.
  // },
};

export default migration;
EOF

echo "Создан: $FILE"
echo ""
echo "Дальше:"
echo "  1. Открой файл и заполни description + up()"
echo "  2. Проверь идемпотентность (повторный запуск не должен ломать)"
echo "  3. cd migrations && npx tsc"
echo "  4. node migrations/dist/runner.js up --dry-run   # симуляция"
echo "  5. node migrations/dist/runner.js up             # применение"
