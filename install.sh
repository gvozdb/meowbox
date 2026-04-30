#!/usr/bin/env bash
# =============================================================================
# Meowbox — Server Management Panel
# Установщик для Ubuntu 22.04+ / Debian 12+
#
# Хранилище: SQLite (один файл data/meowbox.db) — PostgreSQL и Redis больше
# не требуются. Панель потребляет ~150 МБ RAM (было ~450 МБ с PG+Redis).
# =============================================================================
set -euo pipefail

# Полностью неинтерактивный режим: никаких debconf-диалогов про kernel upgrade,
# конфиги старого пакета сохраняем, новый устанавливаем без вопросов.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1
APT_OPTS=(-y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

MEOWBOX_DIR="${MEOWBOX_DIR:-/opt/meowbox}"
NODE_VERSION="22"
LOG_FILE="${LOG_FILE:-/var/log/meowbox-install.log}"
PROXY_TOKEN=""
RELEASE_MODE="auto"  # auto | release | legacy

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy-token)
      PROXY_TOKEN="$2"
      shift 2
      ;;
    --release-mode)
      RELEASE_MODE="release"
      shift
      ;;
    --legacy-mode)
      RELEASE_MODE="legacy"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# =============================================================================
# Source-of-truth раскладки.
#
# В release-mode:
#   - install.sh запущен из /opt/meowbox/current/install.sh (или releases/<v>/install.sh)
#   - dist/ собран в CI, нужен только `npm ci --omit=dev`
#   - persistent state — в /opt/meowbox/state/
#   - .env лежит в state/.env, симлинк в release/.env
#
# В legacy-mode:
#   - install.sh запущен из /opt/meowbox/install.sh (git checkout)
#   - нужно собрать всё из исходников (npm ci + npm run build)
#   - .env, data/ — прямо в /opt/meowbox/
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Auto-detect: если в этом каталоге есть api/dist/main.js — release.
if [[ "$RELEASE_MODE" == "auto" ]]; then
  if [[ -f "$SCRIPT_DIR/api/dist/main.js" ]] && [[ -f "$SCRIPT_DIR/web/.output/server/index.mjs" ]]; then
    RELEASE_MODE="release"
  else
    RELEASE_MODE="legacy"
  fi
fi

if [[ "$RELEASE_MODE" == "release" ]]; then
  # Source of truth — каталог скрипта (release dir или current/).
  CODE_DIR="$SCRIPT_DIR"
  STATE_DIR="$MEOWBOX_DIR/state"
  ENV_FILE="$STATE_DIR/.env"
  mkdir -p "$STATE_DIR/data" "$STATE_DIR/logs" "$STATE_DIR/backups" "$STATE_DIR/snapshots"
  chmod 700 "$STATE_DIR/data"
else
  # Legacy: всё в корне MEOWBOX_DIR
  CODE_DIR="$MEOWBOX_DIR"
  STATE_DIR="$MEOWBOX_DIR"
  ENV_FILE="$MEOWBOX_DIR/.env"
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
AMBER='\033[0;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[meowbox]${NC} $1"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }
warn()  { echo -e "${AMBER}[meowbox]${NC} $1"; }
error() { echo -e "${RED}[meowbox]${NC} $1"; exit 1; }

# =============================================================================
# Pre-flight checks
# =============================================================================

if [[ $EUID -ne 0 ]]; then
  error "Запусти под root (через sudo)"
fi

if ! grep -qiE 'ubuntu|debian' /etc/os-release 2>/dev/null; then
  error "Поддерживается только Ubuntu 22.04+ / Debian 12+"
fi

log "Starting Meowbox installation..."
log "Mode: $RELEASE_MODE  |  Code: $CODE_DIR  |  State: $STATE_DIR"
log "Log file: $LOG_FILE"
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

# =============================================================================
# System update + dependencies
# =============================================================================

log "Updating system packages..."
apt-get update -qq >> "$LOG_FILE" 2>&1
apt-get "${APT_OPTS[@]}" upgrade >> "$LOG_FILE" 2>&1

log "Installing dependencies..."
# passwd            — useradd/usermod/userdel/groupadd/gpasswd для per-site юзеров
#                     (на минималках типа debian-slim может отсутствовать).
# openssl           — SHA-512 хэш паролей в SystemUserManager + генерация ticket'ов SSO.
# rsync             — копирование файлов сайтов при duplicate / deploy.
# acl               — setfacl, могут понадобиться для тонких прав на каталоги сайтов.
# cron              — systemd-юнит должен быть, иначе CronJob-фича панели не работает.
# restic            — backup-движок (репозитории сайтов, дампы БД, restic snapshot).
# mariadb-server    — обязательный движок БД для сайтов (MySQL-совместимый).
#                     mariadb-client даёт бинари mariadb, mariadb-dump + симлинки mysql/mysqldump,
#                     поэтому отдельный mysql-server не нужен (он бы ещё конфликтовал по портам).
#                     Свежий mariadb-server на Debian/Ubuntu из коробки даёт unix_socket auth для
#                     root → агент подключается как `mariadb -u root` без пароля.
# postgresql        — обязательный движок БД для сайтов. Метапакет тянет дистровскую версию
#                     (Ubuntu 22.04 → pg14, Debian 12 → pg15, Ubuntu 24.04 → pg16).
#                     Peer auth для юзера `postgres` → агент подключается через `sudo -u postgres psql`.
# postgresql-client — pg_dump / psql на хосте.
apt-get "${APT_OPTS[@]}" install \
  curl wget git unzip software-properties-common \
  gnupg2 ca-certificates lsb-release \
  nginx certbot python3-certbot-nginx \
  sqlite3 build-essential \
  ufw \
  passwd openssl rsync acl cron restic \
  mariadb-server mariadb-client \
  postgresql postgresql-client >> "$LOG_FILE" 2>&1

# Включаем БД-движки. apt-у обычно делает enable + start самостоятельно, но
# на минимальных образах без systemd-policy всё может остаться stopped.
log "Enabling MariaDB + PostgreSQL..."
systemctl enable --now mariadb     >> "$LOG_FILE" 2>&1 || \
  systemctl enable --now mysql     >> "$LOG_FILE" 2>&1 || true
systemctl enable --now postgresql  >> "$LOG_FILE" 2>&1 || true

# -----------------------------------------------------------------------------
# PHP-FPM: дистровский PHP + ondrej/php PPA для нескольких версий
# -----------------------------------------------------------------------------
# Сайты в панели создаются с выбором phpVersion (8.1 / 8.2 / 8.3 / 8.4).
# Если на сервере есть только дефолтная дистровская версия — провижининг
# падает с "spawn php8.X ENOENT" посередине установки CMS. Чтобы у юзера
# всегда был полный спектр, подключаем ondrej/php PPA и ставим 8.1+8.2+8.3.
# На Debian используем sury.org как эквивалент.
log "Adding PHP repository (ondrej/php on Ubuntu, sury.org on Debian)..."

# Определяем дистрибутив.
DISTRO_ID=$(. /etc/os-release && echo "${ID:-unknown}")
DISTRO_CODENAME=$(lsb_release -cs 2>/dev/null || echo "")

if [[ "$DISTRO_ID" == "ubuntu" ]]; then
  if ! grep -rq "ondrej/php" /etc/apt/sources.list.d/ 2>/dev/null; then
    add-apt-repository -y ppa:ondrej/php >> "$LOG_FILE" 2>&1 || \
      warn "Не удалось добавить ondrej/php — будет только дистровская версия PHP"
    apt-get update -qq >> "$LOG_FILE" 2>&1
  fi
elif [[ "$DISTRO_ID" == "debian" ]] && [[ -n "$DISTRO_CODENAME" ]]; then
  if [[ ! -f /etc/apt/sources.list.d/sury-php.list ]]; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://packages.sury.org/php/apt.gpg \
      -o /etc/apt/keyrings/sury-php.gpg 2>>"$LOG_FILE" && \
      chmod a+r /etc/apt/keyrings/sury-php.gpg && \
      echo "deb [signed-by=/etc/apt/keyrings/sury-php.gpg] https://packages.sury.org/php/ ${DISTRO_CODENAME} main" \
        > /etc/apt/sources.list.d/sury-php.list && \
      apt-get update -qq >> "$LOG_FILE" 2>&1 || \
      warn "Не удалось добавить sury.org — будет только дистровская версия PHP"
  fi
fi

# Какие версии ставим: 8.1, 8.2, 8.3 (и 8.4 если есть в репо). Дистровская
# версия всё равно устанавливается отдельно — её используют системные пакеты
# (Adminer и т.п.).
log "Installing PHP-FPM versions (8.1 + 8.2 + 8.3 + system default)..."

# Базовый набор: дистровский PHP (для Adminer и системных нужд).
apt-get "${APT_OPTS[@]}" install \
  php-cli php-fpm php-mysql php-pgsql php-sqlite3 \
  php-mbstring php-curl php-zip >> "$LOG_FILE" 2>&1

# Дополнительные версии для пользовательских сайтов. Каждую обернём в `|| true`,
# чтобы недоступная версия (например, 8.4 на старом репо) не валила установку.
for V in 8.1 8.2 8.3 8.4; do
  if apt-cache show "php${V}-cli" >/dev/null 2>&1; then
    log "  → installing PHP ${V}..."
    apt-get "${APT_OPTS[@]}" install \
      "php${V}-cli" "php${V}-fpm" \
      "php${V}-mysql" "php${V}-pgsql" "php${V}-sqlite3" \
      "php${V}-mbstring" "php${V}-curl" "php${V}-zip" \
      "php${V}-xml" "php${V}-gd" "php${V}-bcmath" "php${V}-intl" \
      >> "$LOG_FILE" 2>&1 || warn "    PHP ${V} install partial — некоторые модули не доступны"
  else
    log "  → PHP ${V} в репо не найден, пропускаю"
  fi
done

# Определяем дефолтную дистровскую версию для путей /etc/php/X.Y/fpm/...
# (используется секцией Adminer ниже). Берём САМУЮ ВЫСОКУЮ установленную,
# а не первую попавшуюся — это совпадает с системным `php` симлинком.
PHP_VERSION=$(ls /etc/php 2>/dev/null | grep -E '^[0-9]+\.[0-9]+$' | sort -rV | head -n1)
if [[ -z "$PHP_VERSION" ]]; then
  error "PHP не установился — проверь $LOG_FILE"
fi
log "Default PHP version (для Adminer): ${PHP_VERSION}"
log "Установленные PHP версии: $(ls /etc/php 2>/dev/null | grep -E '^[0-9]+\.[0-9]+$' | sort -V | tr '\n' ' ')"

# -----------------------------------------------------------------------------
# Composer — нужен агенту для composer-based установок (MODX 3, Laravel и т.п.).
# Без composer агент откатывается на ZIP-инсталлер, что медленнее и не всегда
# работает (зависимые пакеты не подтянутся). Ставим официальным installer'ом
# с проверкой sha384 — пакет distro обычно слишком старый.
# -----------------------------------------------------------------------------
if ! command -v composer &>/dev/null; then
  log "Installing Composer..."
  COMPOSER_TMP=$(mktemp -d)
  pushd "$COMPOSER_TMP" >/dev/null
  EXPECTED_CHECKSUM="$(curl -fsSL https://composer.github.io/installer.sig)"
  curl -fsSL https://getcomposer.org/installer -o composer-setup.php
  ACTUAL_CHECKSUM="$(php -r "echo hash_file('sha384', 'composer-setup.php');")"
  if [[ "$EXPECTED_CHECKSUM" != "$ACTUAL_CHECKSUM" ]]; then
    rm -f composer-setup.php
    popd >/dev/null
    rm -rf "$COMPOSER_TMP"
    error "Composer installer checksum mismatch — отказываемся ставить"
  fi
  php composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer >> "$LOG_FILE" 2>&1
  rm -f composer-setup.php
  popd >/dev/null
  rm -rf "$COMPOSER_TMP"
  log "Composer $(composer --version --no-ansi 2>/dev/null | head -n1) installed"
else
  log "Composer already installed: $(composer --version --no-ansi 2>/dev/null | head -n1)"
fi

# =============================================================================
# GitHub CLI (gh) — нужен tools/update.sh для надёжного скачивания релизов.
# Без него работает curl-fallback, но gh проще для приватных репо и проверки
# attestation. Ставим из официального apt-репозитория cli.github.com.
# =============================================================================
if ! command -v gh &>/dev/null; then
  log "Installing GitHub CLI (gh)..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq >> "$LOG_FILE" 2>&1
  apt-get "${APT_OPTS[@]}" install gh >> "$LOG_FILE" 2>&1
  log "gh installed: $(gh --version 2>/dev/null | head -n1)"
else
  log "gh already installed: $(gh --version 2>/dev/null | head -n1)"
fi

# =============================================================================
# Node.js 22 LTS
# =============================================================================

if ! command -v node &>/dev/null || [[ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt "$NODE_VERSION" ]]; then
  log "Installing Node.js ${NODE_VERSION}..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - >> "$LOG_FILE" 2>&1
  apt-get "${APT_OPTS[@]}" install nodejs >> "$LOG_FILE" 2>&1
else
  log "Node.js $(node -v) already installed"
fi

# PM2
if ! command -v pm2 &>/dev/null; then
  log "Installing PM2..."
  npm install -g pm2 >> "$LOG_FILE" 2>&1
fi

# =============================================================================
# Generate secrets
# =============================================================================

JWT_ACCESS_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
AGENT_SECRET=$(openssl rand -hex 32)
INTERNAL_TOKEN=$(openssl rand -hex 32)
WEBHOOK_SECRET=$(openssl rand -hex 32)
# Adminer SSO master-key: 32 байта в base64 (AES-256-GCM).
# Тот же ключ читает PHP в /opt/meowbox/tools/adminer/lib/sso.php.
ADMINER_SSO_KEY=$(openssl rand -base64 32)
# PROXY_TOKEN: server-to-server bearer для master→slave проксирования.
# Если оператор не передал --proxy-token — генерируем сами, чтобы slave-сервер
# был сразу готов принимать прокси-запросы из мастер-панели после установки.
# Достаточно зайти в state/.env и скопировать PROXY_TOKEN в форму "Добавить сервер".
if [[ -z "$PROXY_TOKEN" ]]; then
  PROXY_TOKEN=$(openssl rand -hex 32)
fi

# =============================================================================
# Create .env (только если его ещё нет — не затираем существующий)
# =============================================================================

if [[ ! -f "${ENV_FILE}" ]]; then
  log "Creating configuration at ${ENV_FILE}..."
  # КРИТИЧНО: DATABASE_URL должен быть АБСОЛЮТНЫМ.
  # Prisma резолвит относительный путь от schema.prisma (api/prisma/), а в
  # release-раскладке api/prisma/ живёт внутри releases/<v>/, и относительный
  # `../../state/data/...` уезжает в releases/<v>/state/data/ вместо общего
  # /opt/meowbox/state/data/. Это ломает persistence между релизами.
  if [[ "$RELEASE_MODE" == "release" ]]; then
    DB_URL="file:${STATE_DIR}/data/meowbox.db"
  else
    DB_URL="file:${MEOWBOX_DIR}/data/meowbox.db"
  fi
  cat > "${ENV_FILE}" << ENV
# Meowbox Environment — Auto-generated
# SQLite — единственная БД панели. Путь АБСОЛЮТНЫЙ:
#   release: /opt/meowbox/state/data/meowbox.db (общий для всех релизов)
#   legacy:  /opt/meowbox/data/meowbox.db
# Не делать относительным — Prisma резолвит от api/prisma/ и уедет внутрь release-каталога.
DATABASE_URL="${DB_URL}"

JWT_ACCESS_SECRET="${JWT_ACCESS_SECRET}"
JWT_ACCESS_EXPIRES_IN="15m"
JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET}"
JWT_REFRESH_EXPIRES_IN="7d"

AGENT_SECRET="${AGENT_SECRET}"
# Отдельный секрет для Nuxt ↔ API (Basic Auth verify). Обязан отличаться
# от AGENT_SECRET — fallback больше не поддерживается.
INTERNAL_TOKEN="${INTERNAL_TOKEN}"
WEBHOOK_SECRET="${WEBHOOK_SECRET}"

# --- Ports ---
# Meowbox стандартно использует порты 11860 (API) / 11861 (Web) / 11862 (Nginx reverse-proxy).
# Меняй только если они заняты — тогда регенерируй nginx-конфиг повторным запуском install.sh.
API_PORT=${API_PORT:-11860}
API_HOST="${API_HOST:-127.0.0.1}"
WEB_PORT=${WEB_PORT:-11861}
PANEL_PORT=${PANEL_PORT:-11862}
PANEL_DOMAIN="${PANEL_DOMAIN:-localhost}"

NODE_ENV="production"

# Site storage base path (per-site user home directories created here)
SITES_BASE_PATH="/var/www"

# Adminer SSO — общий секрет между Node API и PHP Adminer для шифрования
# одноразовых ticket'ов и сессионных кук (AES-256-GCM, 32 байта в base64).
ADMINER_SSO_KEY="${ADMINER_SSO_KEY}"

# PROXY_TOKEN: server-to-server токен для master→slave прокси.
# Сгенерирован автоматически — скопируй его в форму "Добавить сервер"
# на master-панели чтобы подключить этот сервер.
PROXY_TOKEN="${PROXY_TOKEN}"
ENV

  log "PROXY_TOKEN сгенерирован — см. state/.env (нужен для подключения сервера к master-панели)"

  chmod 600 "${ENV_FILE}"
else
  log ".env уже существует (${ENV_FILE}) — не трогаем"
  if ! grep -q '^ADMINER_SSO_KEY=' "${ENV_FILE}"; then
    log "Adding ADMINER_SSO_KEY to existing .env"
    {
      echo ""
      echo "# Adminer SSO master-key (auto-added during update)"
      echo "ADMINER_SSO_KEY=\"${ADMINER_SSO_KEY}\""
    } >> "${ENV_FILE}"
  fi
  # PROXY_TOKEN: дописываем если не задан (старые установки до 0.4.x не имели его).
  # Закомментированная строка PROXY_TOKEN=CHANGE_ME... тоже считается "не задан".
  if ! grep -qE '^PROXY_TOKEN="[^"]+"' "${ENV_FILE}"; then
    log "Adding PROXY_TOKEN to existing .env (auto-generated)"
    {
      echo ""
      echo "# PROXY_TOKEN: server-to-server токен для master→slave прокси (auto-added)"
      echo "PROXY_TOKEN=\"${PROXY_TOKEN}\""
    } >> "${ENV_FILE}"
  fi
  # Чиним relative DATABASE_URL → absolute (баг до v0.3.8: путь резолвился
  # внутрь releases/<v>/state/data/ из-за file:../../state/data/...).
  if grep -qE '^DATABASE_URL="file:\.\.' "${ENV_FILE}"; then
    if [[ "$RELEASE_MODE" == "release" ]]; then
      NEW_DB_URL="file:${STATE_DIR}/data/meowbox.db"
    else
      NEW_DB_URL="file:${MEOWBOX_DIR}/data/meowbox.db"
    fi
    log "DATABASE_URL был относительным — переписываю в абсолютный (${NEW_DB_URL})"
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"${NEW_DB_URL}\"|" "${ENV_FILE}"
  fi
  chmod 600 "${ENV_FILE}"
fi

# Перенос БД, если она оказалась внутри release-каталога (баг до v0.3.8).
# Сценарий: install.sh положил БД в releases/<v>/state/data/meowbox.db из-за
# относительного DATABASE_URL. Переносим в общий /opt/meowbox/state/data/.
if [[ "$RELEASE_MODE" == "release" ]]; then
  ORPHAN_DB="${CODE_DIR}/state/data/meowbox.db"
  TARGET_DB="${STATE_DIR}/data/meowbox.db"
  if [[ -f "$ORPHAN_DB" ]] && [[ ! -f "$TARGET_DB" ]]; then
    log "БД найдена внутри release (${ORPHAN_DB}) — переношу в ${TARGET_DB}"
    mv "$ORPHAN_DB" "$TARGET_DB"
    # Также журнал/wal если есть
    [[ -f "${ORPHAN_DB}-journal" ]] && mv "${ORPHAN_DB}-journal" "${TARGET_DB}-journal"
    [[ -f "${ORPHAN_DB}-wal" ]] && mv "${ORPHAN_DB}-wal" "${TARGET_DB}-wal"
    [[ -f "${ORPHAN_DB}-shm" ]] && mv "${ORPHAN_DB}-shm" "${TARGET_DB}-shm"
    chmod 600 "$TARGET_DB"
  elif [[ -f "$ORPHAN_DB" ]] && [[ -f "$TARGET_DB" ]]; then
    warn "Конфликт: БД и в ${ORPHAN_DB}, и в ${TARGET_DB}. Оставляю ${TARGET_DB} как канон, удаляю orphan."
    rm -f "$ORPHAN_DB" "${ORPHAN_DB}-journal" "${ORPHAN_DB}-wal" "${ORPHAN_DB}-shm"
  fi
  # Удаляем мусорный releases/<v>/state/ (если пустой после переноса)
  if [[ -d "${CODE_DIR}/state" ]]; then
    rmdir "${CODE_DIR}/state/data" 2>/dev/null || true
    rmdir "${CODE_DIR}/state" 2>/dev/null || true
  fi
fi

# В release-режиме .env живёт в state/.env, а api ожидает его рядом с собой
# (envFilePath: '../.env' от cwd=api/). Создаём симлинк code/.env → state/.env.
if [[ "$RELEASE_MODE" == "release" ]]; then
  if [[ ! -L "${CODE_DIR}/.env" ]] || [[ "$(readlink "${CODE_DIR}/.env")" != "${ENV_FILE}" ]]; then
    ln -sfn "${ENV_FILE}" "${CODE_DIR}/.env"
  fi
  # data/ → state/data/ симлинк (DATABASE_URL уже абсолютный, симлинк только
  # для удобства дампов и ad-hoc sqlite3 запросов из release-каталога).
  if [[ ! -e "${CODE_DIR}/data" ]]; then
    ln -sfn "${STATE_DIR}/data" "${CODE_DIR}/data"
  fi
fi

# =============================================================================
# Install npm dependencies + build
# =============================================================================

mkdir -p "${STATE_DIR}/data"
chmod 700 "${STATE_DIR}/data"

cd "${CODE_DIR}"

if [[ "$RELEASE_MODE" == "release" ]]; then
  # Тарболл уже содержит dist/. Ставим production-зависимости только в тех
  # пакетах, у которых есть package-lock.json и реальные runtime-deps.
  # shared/ и migrations/ — это собранные артефакты без runtime-зависимостей
  # (зависимости резолвятся через симлинки), поэтому npm ci там не нужен и
  # упадёт из-за отсутствия package-lock.json в тарболле.
  log "Installing production dependencies (npm ci --omit=dev)..."
  for pkg in agent api web; do
    if [[ -f "${CODE_DIR}/${pkg}/package-lock.json" ]]; then
      (cd "${CODE_DIR}/${pkg}" && npm ci --omit=dev --no-audit --no-fund >> "$LOG_FILE" 2>&1) \
        || error "npm ci провалился в ${pkg}"
    fi
  done

  # @meowbox/shared не объявлен в dependencies — линкуем вручную.
  # Глубина: <pkg>/node_modules/@meowbox/shared → ../../../shared
  log "Создаю symlink-и @meowbox/shared в node_modules пакетов..."
  for pkg in api agent web migrations; do
    mkdir -p "${CODE_DIR}/${pkg}/node_modules/@meowbox"
    ln -sfn "../../../shared" "${CODE_DIR}/${pkg}/node_modules/@meowbox/shared"
  done

  # migrations/runner.ts использует @prisma/client — линкуем из api/.
  if [[ -d "${CODE_DIR}/api/node_modules/@prisma/client" ]]; then
    mkdir -p "${CODE_DIR}/migrations/node_modules/@prisma"
    ln -sfn "../../../api/node_modules/@prisma/client" "${CODE_DIR}/migrations/node_modules/@prisma/client"
  fi
else
  log "Installing Meowbox dependencies (full, legacy mode)..."
  # Shared — собирается первым, используется остальными через paths
  (cd shared && npm ci >> "$LOG_FILE" 2>&1 && npm run build >> "$LOG_FILE" 2>&1)
  (cd api && npm ci >> "$LOG_FILE" 2>&1)
  (cd agent && npm ci >> "$LOG_FILE" 2>&1)
  (cd web && npm ci >> "$LOG_FILE" 2>&1)
fi

# =============================================================================
# Database setup (SQLite via Prisma)
# =============================================================================

log "Applying SQLite schema..."
(
  cd "${CODE_DIR}/api"
  set -a; source "${ENV_FILE}"; set +a
  npx prisma generate >> "$LOG_FILE" 2>&1
  # db push: применяет schema.prisma без формальных миграций —
  # подходит для self-hosted панели (одна ветка схемы на всю историю).
  npx prisma db push --skip-generate --accept-data-loss >> "$LOG_FILE" 2>&1
)

# =============================================================================
# Build (только в legacy-mode — в release dist уже в тарболле)
# =============================================================================

if [[ "$RELEASE_MODE" != "release" ]]; then
  log "Building Meowbox (legacy mode)..."
  (cd "${CODE_DIR}/api"   && npx tsc -p tsconfig.build.json --incremental false >> "$LOG_FILE" 2>&1)
  (cd "${CODE_DIR}/agent" && npx tsc >> "$LOG_FILE" 2>&1)
  (cd "${CODE_DIR}/web"   && npx nuxt build >> "$LOG_FILE" 2>&1)
fi

# =============================================================================
# Adminer (lightweight DB browser) — встроенная установка с SSO
# =============================================================================

log "Setting up embedded Adminer..."

# В release-mode Adminer-каталог должен жить вне releases/<v>/ (иначе при
# каждом обновлении меняется путь — pool.d / nginx ломаются). Кладём в state/
# и симлинкаем в release как tools/adminer для совместимости.
if [[ "$RELEASE_MODE" == "release" ]]; then
  ADMINER_DIR="${STATE_DIR}/adminer"
  mkdir -p "${ADMINER_DIR}"
  # Симлинк tools/adminer → state/adminer (для путей внутри release)
  if [[ -d "${CODE_DIR}/tools/adminer" ]] && [[ ! -L "${CODE_DIR}/tools/adminer" ]]; then
    rm -rf "${CODE_DIR}/tools/adminer"
  fi
  ln -sfn "${ADMINER_DIR}" "${CODE_DIR}/tools/adminer"
else
  ADMINER_DIR="${CODE_DIR}/tools/adminer"
fi

ADMINER_VERSION="${ADMINER_VERSION:-4.8.1}"
ADMINER_URL="https://github.com/vrana/adminer/releases/download/v${ADMINER_VERSION}/adminer-${ADMINER_VERSION}.php"
ADMINER_BIN="${ADMINER_DIR}/adminer.php"

mkdir -p "${ADMINER_DIR}/lib"

# Скачиваем единый PHP-файл Adminer'а, если его ещё нет (или версия отличается).
if [[ ! -f "${ADMINER_BIN}" ]] || ! grep -q "v${ADMINER_VERSION}" "${ADMINER_BIN}" 2>/dev/null; then
  log "Downloading Adminer ${ADMINER_VERSION}..."
  curl -fsSL -o "${ADMINER_BIN}.tmp" "${ADMINER_URL}" >> "$LOG_FILE" 2>&1
  mv "${ADMINER_BIN}.tmp" "${ADMINER_BIN}"
fi

# -----------------------------------------------------------------------------
# Изолированный системный юзер для PHP-FPM пула Adminer'а.
# Не имеет доступа к файлам сайтов, не может ssh, без shell.
# -----------------------------------------------------------------------------
if ! id -u meowbox-adminer &>/dev/null; then
  useradd --system --shell /usr/sbin/nologin --no-create-home --user-group meowbox-adminer
  log "Created system user meowbox-adminer"
fi

# meowbox-adminer должен быть в группе www-data, чтобы PHP-FPM мог читать
# файлы каталога Adminer (владелец = root, группа = www-data, 750/640).
# nginx тоже работает от www-data — заодно и он читает напрямую.
usermod -aG www-data meowbox-adminer >> "$LOG_FILE" 2>&1 || true

# Права на каталог Adminer.
chown -R root:www-data "${ADMINER_DIR}"
find "${ADMINER_DIR}" -type d -exec chmod 750 {} \;
find "${ADMINER_DIR}" -type f -exec chmod 640 {} \;

# -----------------------------------------------------------------------------
# PHP-FPM pool config — отдельный сокет, отдельный юзер, open_basedir lock.
# -----------------------------------------------------------------------------
ADMINER_POOL="/etc/php/${PHP_VERSION}/fpm/pool.d/meowbox-adminer.conf"
cat > "${ADMINER_POOL}" << POOL
; Meowbox Adminer FPM pool — изолированный, без доступа к файлам сайтов.
[meowbox-adminer]
user = meowbox-adminer
group = meowbox-adminer

listen = /run/php/meowbox-adminer.sock
listen.owner = www-data
listen.group = www-data
listen.mode = 0660

pm = ondemand
pm.max_children = 10
pm.process_idle_timeout = 30s
pm.max_requests = 500

; Жёстко ограничиваем PHP только тем, что нужно Adminer'у:
;   - сам каталог adminer (для include adminer.php / lib/*)
;   - /tmp (php сессии + временные импорты дампов)
;   - .env панели (read-only — сюда читаем ADMINER_SSO_KEY)
php_admin_value[open_basedir] = ${ADMINER_DIR}:/tmp:/var/lib/php/sessions:${ENV_FILE}
php_admin_value[upload_tmp_dir] = /tmp
php_admin_value[session.save_path] = /var/lib/php/sessions
php_admin_value[memory_limit] = 128M
php_admin_value[post_max_size] = 128M
php_admin_value[upload_max_filesize] = 128M
php_admin_value[expose_php] = 0
php_admin_flag[display_errors] = off
php_admin_flag[log_errors] = on
php_admin_value[error_log] = /var/log/meowbox-adminer.error.log

; Передаём ключ напрямую в env-переменную FPM-пула — sso.php прочитает
; через getenv() даже без чтения .env. /opt/meowbox/.env — fallback.
env[ADMINER_SSO_KEY] = "${ADMINER_SSO_KEY}"
clear_env = no
POOL

# Каталог сессий PHP — пермишены для нашего юзера.
mkdir -p /var/lib/php/sessions
chown root:meowbox-adminer /var/lib/php/sessions
chmod 1730 /var/lib/php/sessions

touch /var/log/meowbox-adminer.error.log
chown meowbox-adminer:meowbox-adminer /var/log/meowbox-adminer.error.log
chmod 640 /var/log/meowbox-adminer.error.log

# Нужен ли meowbox-adminer'у доступ на чтение .env?
# .env обычно 600 root:root. Дадим mode=640 + добавим нашего юзера в группу root.
# Это уже не "максимально безопасно", поэтому делаем иначе: sso.php первым делом
# пробует ENV (приоритет), и ENV у нас передаётся через FPM env[]. Файл .env
# нужен только как fallback — но юзер не сможет его читать, и это нормально.
# Поэтому НИЧЕГО не добавляем в группы.

systemctl enable "php${PHP_VERSION}-fpm" >> "$LOG_FILE" 2>&1 || true
systemctl restart "php${PHP_VERSION}-fpm" >> "$LOG_FILE" 2>&1
log "Adminer PHP-FPM pool ready (socket /run/php/meowbox-adminer.sock)"

# Сервисы, которые должны переживать ребут хоста.
systemctl enable nginx >> "$LOG_FILE" 2>&1 || true
systemctl enable cron  >> "$LOG_FILE" 2>&1 || true

# =============================================================================
# Nginx global shared zones (используются конфигами сайтов: limit_req zone=site_limit)
# =============================================================================
# Файл попадает в /etc/nginx/conf.d/, который inсluded из http{} в дистровском
# nginx.conf. Без этой зоны генерируемые конфиги сайтов падают на nginx -t с
# "zero size shared memory zone site_limit".
log "Configuring Nginx global zones (placeholder, агент перезапишет per-site)..."
cat > /etc/nginx/conf.d/meowbox-zones.conf <<'NGINX_ZONES'
# === Meowbox global rate-limit zones (placeholder из install.sh) ===
# Файл будет полностью перезаписан агентом при создании первого сайта
# (per-site limit_req_zone + legacy site_limit для backwards-compat).
limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;
NGINX_ZONES

# =============================================================================
# Nginx config for the panel itself
# =============================================================================

log "Configuring Nginx for panel..."
# Считываем фактические значения из созданного .env (если юзер его правил до install.sh)
set -a; source "${ENV_FILE}"; set +a
PANEL_DOMAIN="${PANEL_DOMAIN:-localhost}"
PANEL_PORT="${PANEL_PORT:-11862}"
API_PORT="${API_PORT:-11860}"
WEB_PORT="${WEB_PORT:-11861}"

cat > /etc/nginx/sites-available/meowbox-panel << NGINX
upstream meowbox_api {
    server 127.0.0.1:${API_PORT};
}

upstream meowbox_web {
    server 127.0.0.1:${WEB_PORT};
}

server {
    listen ${PANEL_PORT};
    listen [::]:${PANEL_PORT};
    server_name ${PANEL_DOMAIN} _;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # API: long-running endpoints (server provisioning, etc.)
    location /api/servers/provision {
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
    }

    # API proxy
    location /api/ {
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }

    # WebSocket (Socket.io for agent)
    location /socket.io/ {
        proxy_pass http://meowbox_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
    }

    # Nuxt HMR WebSocket
    location /_nuxt/ {
        proxy_pass http://meowbox_web;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
    }

    # ---------------------------------------------------------------------
    # Adminer (встроенный, /adminer/) — отдельный PHP-FPM пул
    # /adminer/sso.php — обмен одноразового SSO-ticket'а на сессионную куку
    # /adminer/        — сам Adminer (читает credentials из куки)
    # ---------------------------------------------------------------------
    location ^~ /adminer/ {
        alias ${ADMINER_DIR}/;
        index index.php;

        # Запрет браузерной/поисковой индексации.
        add_header X-Robots-Tag "noindex,nofollow" always;
        add_header X-Frame-Options "SAMEORIGIN" always;

        # Лимит на тело POST (Adminer-импорты дампов и т.п.).
        client_max_body_size 128m;

        try_files \$uri \$uri/ /adminer/index.php?\$args;

        # Запрет прямого доступа к нашим helpers (lib/sso.php, lib/meowbox-plugin.php).
        location ~ ^/adminer/lib/ {
            deny all;
            return 403;
        }

        # Обработка PHP — фронт-контроллер /adminer/index.php или /adminer/sso.php.
        # Маршрутизируем оба, остальные .php-файлы внутри adminer/ запрещены.
        location ~ ^/adminer/(index|sso|adminer)\.php\$ {
            alias ${ADMINER_DIR}/;
            try_files /\$1.php =404;

            fastcgi_pass unix:/run/php/meowbox-adminer.sock;
            fastcgi_index index.php;
            fastcgi_param SCRIPT_FILENAME ${ADMINER_DIR}/\$1.php;
            fastcgi_param DOCUMENT_ROOT ${ADMINER_DIR};
            include fastcgi_params;
            fastcgi_read_timeout 120s;
            fastcgi_buffers 16 16k;
            fastcgi_buffer_size 32k;
        }
    }

    # Web UI (Nuxt)
    location / {
        proxy_pass http://meowbox_web;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

# Remove old panel configs from previous installs (if any)
rm -f /etc/nginx/sites-enabled/meowbox /etc/nginx/sites-enabled/meowbox-panel.conf
ln -sf /etc/nginx/sites-available/meowbox-panel /etc/nginx/sites-enabled/meowbox-panel
rm -f /etc/nginx/sites-enabled/default
nginx -t >> "$LOG_FILE" 2>&1 && systemctl reload nginx

# =============================================================================
# Firewall
# =============================================================================

log "Configuring firewall..."
ufw --force enable >> "$LOG_FILE" 2>&1 || true
ufw allow ssh >> "$LOG_FILE" 2>&1
ufw allow 80/tcp >> "$LOG_FILE" 2>&1
ufw allow 443/tcp >> "$LOG_FILE" 2>&1
ufw allow ${PANEL_PORT}/tcp >> "$LOG_FILE" 2>&1

# =============================================================================
# PM2 startup
# =============================================================================

log "Setting up PM2 services..."

# В release-mode корневые симлинки обеспечивают, что `make`, `pm2 start
# ecosystem.config.js` и т.п. работают из /opt/meowbox/ независимо от того,
# на какой релиз сейчас указывает current/.
if [[ "$RELEASE_MODE" == "release" ]]; then
  ln -sfn "current/ecosystem.config.js" "${MEOWBOX_DIR}/ecosystem.config.js"
  ln -sfn "current/Makefile"             "${MEOWBOX_DIR}/Makefile"
  ln -sfn "current/tools"                "${MEOWBOX_DIR}/tools"
  ln -sfn "current/VERSION"              "${MEOWBOX_DIR}/VERSION" 2>/dev/null || true
fi

cd "${MEOWBOX_DIR}"

# Жёстко чистим старые процессы перед стартом. Сценарий: оператор сделал
# `rm -rf /opt/meowbox` при живых pm2-процессах — у них остались deleted
# file-descriptor'ы (старая БД, старый node_modules), pm2 reload не помогает,
# приложение падает с SQLITE_READONLY_DBMOVED / Cannot find module.
# `pm2 delete` форсит kill + забывает процесс, следующий `pm2 start` создаёт
# процессы с нуля и нормальными файлами.
for proc in meowbox-api meowbox-web meowbox-agent; do
  pm2 delete "$proc" >> "$LOG_FILE" 2>&1 || true
done

pm2 start ecosystem.config.js >> "$LOG_FILE" 2>&1 || pm2 restart ecosystem.config.js >> "$LOG_FILE" 2>&1
pm2 save >> "$LOG_FILE" 2>&1
pm2 startup systemd -u root --hp /root >> "$LOG_FILE" 2>&1 || true

# =============================================================================
# Create backup directory
# =============================================================================

mkdir -p /var/meowbox/backups
chmod 700 /var/meowbox/backups

# =============================================================================
# Self-check: убеждаемся, что все обязательные бинари видны через PATH.
# Часть из них (useradd/usermod/etc.) лежит в /usr/sbin — на минималках
# или нестандартных образах PATH у фоновых сервисов может не включать
# /usr/sbin, и агент упадёт на step 0 при создании сайта со `spawn ENOENT`.
# Дополнительная страховка — buildPath() в agent/src/command-executor.ts,
# который при каждом execFile/spawn форсит /usr/sbin:/sbin в PATH.
# =============================================================================

log "Verifying required binaries..."
REQUIRED_BINS=(
  useradd usermod userdel groupadd gpasswd id chage   # passwd
  openssl                                             # password hashes, SSO key
  nginx                                               # web server
  curl wget unzip git rsync                           # деплой/файлы
  sqlite3                                             # SQLite CLI (опционально для отладки)
  certbot                                             # SSL
  pm2 node                                            # рантайм
  restic                                              # backup engine
  mariadb mariadb-dump                                # MariaDB CLI (создание БД, дампы)
  psql pg_dump                                        # PostgreSQL CLI (создание БД, дампы)
  composer                                            # PHP-композер (MODX 3, Laravel и т.п.)
  php                                                 # php-cli (Adminer + composer)
)

# Расширяем PATH на время проверки — иначе sbin-команды могут "не видеться"
# в неинтерактивном root-shell'е некоторых дистров.
export PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"

MISSING=()
for bin in "${REQUIRED_BINS[@]}"; do
  if ! command -v "$bin" &>/dev/null; then
    MISSING+=("$bin")
  fi
done

if (( ${#MISSING[@]} > 0 )); then
  warn "Не найдены бинари: ${MISSING[*]}"
  warn "Установка прошла, но создание сайтов / бэкапов может падать."
  warn "Проверь, что пакеты passwd/coreutils/restic/etc. установлены вручную."
else
  log "All required binaries present."
fi

# =============================================================================
# Done!
# =============================================================================

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     ${AMBER}Meowbox installed successfully! 🐱${GREEN}     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Panel URL:     ${AMBER}http://${PANEL_DOMAIN}:${PANEL_PORT}${NC}"
echo -e "  API:           ${AMBER}http://127.0.0.1:${API_PORT}${NC} (internal)"
echo -e "  Web:           ${AMBER}http://127.0.0.1:${WEB_PORT}${NC} (internal)"
if [[ "$RELEASE_MODE" == "release" ]]; then
  echo -e "  Database:      ${AMBER}${STATE_DIR}/data/meowbox.db${NC} (SQLite)"
  echo -e "  Config:        ${AMBER}${ENV_FILE}${NC}"
  echo -e "  Code:          ${AMBER}${MEOWBOX_DIR}/current → $(basename "$CODE_DIR")${NC}"
else
  echo -e "  Database:      ${AMBER}${MEOWBOX_DIR}/data/meowbox.db${NC} (SQLite)"
  echo -e "  Config:        ${AMBER}${ENV_FILE}${NC}"
fi
echo -e "  Logs:          ${AMBER}pm2 logs${NC}"
echo ""
echo -e "  ${GREEN}Open the panel in your browser to create the admin account.${NC}"
echo ""
log "Installation complete!"
