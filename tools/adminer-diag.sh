#!/usr/bin/env bash
# =============================================================================
# Adminer SSO diagnostics.
#
# Запускать на VPS с проблемой ("Ticket невалиден" или 502 на /adminer/).
# Выводит читаемый отчёт без раскрытия секретов (только fingerprints SHA-1).
#
# Usage:
#   sudo bash /opt/meowbox/tools/adminer-diag.sh
#
# Что проверяет:
#   1. user meowbox-adminer существует.
#   2. ADMINER_SSO_KEY в state/.env (fingerprint).
#   3. ADMINER_SSO_KEY в каждом php-fpm pool meowbox-adminer.conf (fingerprint).
#   4. совпадают ли ключи между .env и всеми pool'ами.
#   5. /run/php/meowbox-adminer.sock существует.
#   6. nginx location /adminer/ есть в meowbox-panel.
#   7. last 30 строк php-fpm error log и /var/log/meowbox-adminer.error.log.
# =============================================================================
set -euo pipefail

PANEL_DIR="${PANEL_DIR:-/opt/meowbox}"
STATE_DIR="${STATE_DIR:-${PANEL_DIR}/state}"
ENV_FILE="${STATE_DIR}/.env"
SOCK="/run/php/meowbox-adminer.sock"
NGINX_PANEL="/etc/nginx/sites-available/meowbox-panel"
ERROR_LOG="/var/log/meowbox-adminer.error.log"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
bad()  { echo -e "  ${RED}✗${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }
sec()  { echo -e "\n${BLUE}━━━ $* ━━━${NC}"; }

fingerprint_of_b64() {
  # Принимает base64 ключ → выводит fingerprint = sha1(raw bytes)[:16] hex.
  local b64="$1"
  [[ -z "$b64" ]] && { echo "<empty>"; return; }
  local raw_len
  raw_len=$(echo -n "$b64" | base64 -d 2>/dev/null | wc -c || echo 0)
  if [[ "$raw_len" != "32" ]]; then
    echo "<invalid len=$raw_len bytes>"
    return
  fi
  echo -n "$b64" | base64 -d | sha1sum | cut -c1-16
}

# --- 1. user meowbox-adminer ----------------------------------------
sec "User meowbox-adminer"
if id meowbox-adminer >/dev/null 2>&1; then
  ok "user существует ($(id meowbox-adminer))"
  if id -nG meowbox-adminer | grep -qw www-data; then
    ok "состоит в группе www-data"
  else
    warn "НЕ в группе www-data — sock может быть недоступен для nginx"
  fi
else
  bad "user meowbox-adminer ОТСУТСТВУЕТ → pool не запустится → 502."
  bad "  Фикс: useradd --shell /usr/sbin/nologin --no-create-home --user-group meowbox-adminer && usermod -aG www-data meowbox-adminer"
fi

# --- 2. ADMINER_SSO_KEY в .env --------------------------------------
sec "ADMINER_SSO_KEY в $ENV_FILE"
ENV_KEY=""
if [[ -r "$ENV_FILE" ]]; then
  ENV_KEY=$(grep -E '^\s*ADMINER_SSO_KEY\s*=' "$ENV_FILE" | head -1 \
    | sed -E 's/^\s*ADMINER_SSO_KEY\s*=\s*"?([^"]+)"?\s*$/\1/')
  if [[ -n "$ENV_KEY" ]]; then
    ok "найден, fingerprint = $(fingerprint_of_b64 "$ENV_KEY")"
  else
    bad ".env существует, но ADMINER_SSO_KEY не найден или пустой"
  fi
else
  bad "$ENV_FILE недоступен — Adminer SSO работать не может"
fi

# --- 3. ADMINER_SSO_KEY в php-fpm pool'ах ---------------------------
sec "ADMINER_SSO_KEY в php-fpm pool'ах"
POOL_COUNT=0
MISMATCH=0
for V in 8.4 8.3 8.2 8.1 8.0 7.4; do
  POOL="/etc/php/${V}/fpm/pool.d/meowbox-adminer.conf"
  [[ -f "$POOL" ]] || continue
  POOL_COUNT=$((POOL_COUNT + 1))
  POOL_KEY=$(grep -E '^env\[ADMINER_SSO_KEY\]' "$POOL" \
    | sed -E 's/^env\[ADMINER_SSO_KEY\]\s*=\s*"?([^"]*)"?\s*$/\1/')
  if [[ -z "$POOL_KEY" ]]; then
    bad "php${V}: env[ADMINER_SSO_KEY] пустой или отсутствует"
    continue
  fi
  POOL_FP=$(fingerprint_of_b64 "$POOL_KEY")
  ENV_FP=$(fingerprint_of_b64 "$ENV_KEY")
  if [[ "$POOL_FP" == "$ENV_FP" && -n "$ENV_FP" ]]; then
    ok "php${V}: pool key синхронизирован с .env ($POOL_FP)"
  else
    bad "php${V}: pool key РАСХОДИТСЯ с .env (pool=$POOL_FP, env=$ENV_FP)"
    MISMATCH=1
  fi
done
if [[ $POOL_COUNT -eq 0 ]]; then
  bad "Ни одного meowbox-adminer.conf не найдено. Pool не установлен."
  bad "  Фикс: запусти миграции (node migrations/dist/runner.js up)"
fi
if [[ $MISMATCH -eq 1 ]]; then
  warn "Расхождение ключей → 'Ticket невалиден или подпись не сошлась'."
  warn "  Фикс: make update до v0.6.30+ (миграция 2026-05-12-002 ресинкает безусловно)"
  warn "  Или ручками: запусти node /opt/meowbox/current/migrations/dist/runner.js up"
fi

# --- 4. sock --------------------------------------------------------
sec "PHP-FPM socket"
if [[ -S "$SOCK" ]]; then
  ok "$SOCK существует ($(stat -c '%U:%G mode=%a' "$SOCK"))"
else
  bad "$SOCK НЕ существует → nginx 502."
  bad "  Возможные причины:"
  bad "    a) pool meowbox-adminer.conf отсутствует / syntax error;"
  bad "    b) user meowbox-adminer не создан;"
  bad "    c) php-fpm не запущен или упал."
  echo
  for V in 8.4 8.3 8.2 8.1 8.0 7.4; do
    if [[ -f "/etc/php/${V}/fpm/pool.d/meowbox-adminer.conf" ]]; then
      echo "  systemctl status php${V}-fpm:"
      systemctl is-active "php${V}-fpm" 2>/dev/null \
        | sed 's/^/    /' || echo "    not-running"
    fi
  done
fi

# --- 5. nginx /adminer/ ---------------------------------------------
sec "nginx /adminer/"
if [[ -f "$NGINX_PANEL" ]]; then
  if grep -qE 'location\s+\^?~?\s*/adminer/' "$NGINX_PANEL"; then
    ok "location /adminer/ есть в $NGINX_PANEL"
    FPASS=$(grep -E 'fastcgi_pass.*adminer' "$NGINX_PANEL" | head -1 | xargs || true)
    if [[ -n "$FPASS" ]]; then
      ok "$FPASS"
    fi
  else
    bad "location /adminer/ ОТСУТСТВУЕТ в $NGINX_PANEL"
    bad "  Фикс: запусти миграцию 2026-05-06-002-patch-nginx-panel-adminer-block"
  fi
else
  warn "$NGINX_PANEL не найден — панель не установлена через install.sh?"
fi

# --- 6. error logs --------------------------------------------------
sec "Последние ошибки в логах"
if [[ -r "$ERROR_LOG" ]]; then
  echo "  $ERROR_LOG (последние 15 строк):"
  tail -n 15 "$ERROR_LOG" | sed 's/^/    /' || true
else
  warn "$ERROR_LOG не найден или нет прав"
fi
echo
for V in 8.4 8.3 8.2 8.1 8.0 7.4; do
  LOG="/var/log/php${V}-fpm.log"
  if [[ -r "$LOG" ]]; then
    LAST=$(grep -iE 'meowbox-adminer|error|warning' "$LOG" | tail -5 || true)
    if [[ -n "$LAST" ]]; then
      echo "  $LOG (последнее про adminer/errors):"
      echo "$LAST" | sed 's/^/    /'
    fi
  fi
done

echo
sec "Готово"
echo "Если есть проблемы выше — самый частый фикс:"
echo "  make update             # подтянет миграцию 2026-05-12-002-resync-adminer-sso"
echo "Или вручную (если update сейчас невозможен):"
echo "  node /opt/meowbox/current/migrations/dist/runner.js up"
echo "  systemctl restart 'php*-fpm'"
