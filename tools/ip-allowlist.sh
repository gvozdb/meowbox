#!/usr/bin/env bash
# =============================================================================
# IP allowlist — быстрый escape-hatch из терминала.
#
# Когда зайти в UI нельзя (заперся снаружи allowlist'а после смены домашнего
# IP / ушёл в роуминг / коллеге дать доступ срочно), правим список напрямую
# в SQLite, потом дёргаем `/api/admin/ip-allowlist/reload` через loopback —
# in-memory BlockList API подхватывает изменения без рестарта.
#
# Команды:
#   tools/ip-allowlist.sh add <IP_or_CIDR> [LABEL]   — добавить + включить
#   tools/ip-allowlist.sh list                       — показать текущий список
#   tools/ip-allowlist.sh clear                      — выключить allowlist
#
# loopback bypass всегда активен → этот скрипт работает даже когда оператор
# забанил сам себя; SSH-туннель + 127.0.0.1 не блокируются.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="${MEOWBOX_STATE_DIR:-$PANEL_DIR/state}"
[[ -d "$STATE_DIR" ]] || STATE_DIR="$PANEL_DIR"
DB_FILE="$STATE_DIR/data/meowbox.db"
[[ -f "$DB_FILE" ]] || DB_FILE="$PANEL_DIR/data/meowbox.db"

if [[ ! -f "$DB_FILE" ]]; then
  echo "[ip-allowlist] meowbox.db не найден (искал в state/data и data/). Аборт." >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[ip-allowlist] sqlite3 не установлен. Поставь: apt-get install -y sqlite3" >&2
  exit 1
fi

# Порт API. По умолчанию 11860; читаем из .env если задан.
API_PORT="${API_PORT:-}"
if [[ -z "$API_PORT" ]]; then
  ENV_FILE="$STATE_DIR/.env"
  [[ -f "$ENV_FILE" ]] || ENV_FILE="$PANEL_DIR/.env"
  if [[ -f "$ENV_FILE" ]]; then
    API_PORT="$(grep -E '^API_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2 | tr -d '"' | tr -d "'" || true)"
  fi
fi
API_PORT="${API_PORT:-11860}"
RELOAD_URL="http://127.0.0.1:${API_PORT}/api/admin/ip-allowlist/reload"

read_setting() {
  sqlite3 "$DB_FILE" \
    "SELECT value FROM panel_settings WHERE key='admin-ip-allowlist';" 2>/dev/null || true
}

write_setting() {
  local json="$1"
  # Эскейпим одинарные кавычки для SQL и экранируем через REPLACE.
  local esc
  esc=$(printf '%s' "$json" | sed "s/'/''/g")
  sqlite3 "$DB_FILE" <<SQL
INSERT INTO panel_settings (key, value, updated_at)
VALUES ('admin-ip-allowlist', '$esc', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
SQL
}

reload_api() {
  # Дёргаем reload через loopback. Auth не нужен — мы внутри сервера, а API
  # стоит за nginx и доступен только с loopback'а напрямую (CIDR 127.0.0.1).
  # Если попадёт 401 — значит JWT-guard не пропустил; тогда юзеру придётся
  # зайти в UI и нажать «Сохранить» (это тоже triggers reload).
  if command -v curl >/dev/null 2>&1; then
    local code
    code=$(curl -fsS -o /dev/null -w '%{http_code}' -X POST "$RELOAD_URL" --max-time 5 || echo 000)
    case "$code" in
      200|201|204) echo "[ip-allowlist] API reloaded ($code)" ;;
      401|403) echo "[ip-allowlist] reload требует ADMIN-JWT — зайди в UI и нажми «Сохранить» (изменения уже в БД)" ;;
      000) echo "[ip-allowlist] API недоступен на $RELOAD_URL — изменения подхватятся после рестарта API" ;;
      *) echo "[ip-allowlist] reload вернул $code — изменения в БД, рестартни API при необходимости" ;;
    esac
  else
    echo "[ip-allowlist] curl не установлен — изменения в БД, перезапусти API: pm2 restart meowbox-api"
  fi
}

show_list() {
  local raw
  raw=$(read_setting)
  if [[ -z "$raw" ]]; then
    echo "Allowlist пуст. Чтобы включить: make ip-allow IP=ваш.ip"
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    echo "$raw" | jq .
  else
    echo "$raw"
  fi
}

clear_list() {
  local raw new
  raw=$(read_setting)
  if [[ -z "$raw" ]]; then
    echo "[ip-allowlist] список и так пуст"
    return 0
  fi
  # Просто отключаем enabled — записи не теряем, чтобы оператор мог включить позже.
  if command -v jq >/dev/null 2>&1; then
    new=$(printf '%s' "$raw" | jq -c '.enabled = false')
  else
    # Простая замена без jq — сработает на нашем формате, который пишем сами.
    new=$(printf '%s' "$raw" | sed -E 's/"enabled":[[:space:]]*true/"enabled":false/')
  fi
  write_setting "$new"
  echo "[ip-allowlist] отключён (записи сохранены)"
  reload_api
}

add_ip() {
  local ip="$1"; local label="${2:-}"
  if [[ -z "$ip" ]]; then
    echo "Usage: tools/ip-allowlist.sh add <IP_or_CIDR> [LABEL]" >&2
    exit 2
  fi
  # Простейшая валидация — IPv4 [/CIDR].
  if ! [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$ ]] && ! [[ "$ip" =~ : ]]; then
    echo "[ip-allowlist] невалидный IP/CIDR: $ip" >&2
    exit 2
  fi
  # Нормализация: одиночный IPv4 → /32, IPv6 → /128.
  if ! [[ "$ip" == */* ]]; then
    if [[ "$ip" =~ : ]]; then ip="${ip}/128"; else ip="${ip}/32"; fi
  fi
  local raw new escaped_label
  raw=$(read_setting)
  escaped_label=$(printf '%s' "$label" | sed 's/"/\\"/g')

  if [[ -z "$raw" ]]; then
    new=$(printf '{"enabled":true,"entries":[{"cidr":"%s","label":"%s"}]}' "$ip" "$escaped_label")
  elif command -v jq >/dev/null 2>&1; then
    new=$(printf '%s' "$raw" | jq -c --arg cidr "$ip" --arg label "$label" \
      '.enabled = true | .entries = ((.entries // []) + [{cidr:$cidr,label:$label}] | unique_by(.cidr))')
  else
    # Без jq — best-effort: просто перезаписываем (теряем старые записи).
    echo "[ip-allowlist] WARNING: jq не установлен, перезаписываю allowlist полностью" >&2
    new=$(printf '{"enabled":true,"entries":[{"cidr":"%s","label":"%s"}]}' "$ip" "$escaped_label")
  fi
  write_setting "$new"
  echo "[ip-allowlist] добавлен $ip${label:+ ($label)}, allowlist включён"
  reload_api
}

cmd="${1:-}"; shift || true
case "$cmd" in
  add) add_ip "${1:-}" "${2:-}" ;;
  list) show_list ;;
  clear) clear_list ;;
  *)
    cat <<HELP
Usage:
  tools/ip-allowlist.sh add <IP_or_CIDR> [LABEL]   # добавить + включить
  tools/ip-allowlist.sh list                       # показать текущий список
  tools/ip-allowlist.sh clear                      # выключить allowlist

Через make:
  make ip-allow IP=1.2.3.4 LABEL=home
  make ip-allow IP=10.0.0.0/24
  make ip-allow-list
  make ip-allow-clear
HELP
    exit 2
    ;;
esac
