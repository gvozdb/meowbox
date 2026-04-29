#!/usr/bin/env bash
# =============================================================================
# Healthcheck для запуска после деплоя/обновления панели.
# Проверяет, что все три PM2 процесса online + API/Web отвечают.
# Возвращает 0 если всё ОК, 1 если что-то не так (детали в stdout).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${MEOWBOX_ENV_FILE:-$PANEL_DIR/state/.env}"
[[ -f "$ENV_FILE" ]] || ENV_FILE="$PANEL_DIR/.env"  # legacy fallback

API_PORT="$(grep -E '^API_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)"
WEB_PORT="$(grep -E '^WEB_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)"
API_PORT="${API_PORT:-11860}"
WEB_PORT="${WEB_PORT:-11861}"
TIMEOUT="${HEALTHCHECK_TIMEOUT:-30}"

fail=0
say() { echo "[healthcheck] $*"; }
err() { echo "[healthcheck] ✗ $*"; fail=1; }

# 1. PM2 — все процессы online
PM2_JSON="$(pm2 jlist 2>/dev/null || echo '[]')"
need=("meowbox-api" "meowbox-agent" "meowbox-web")
for p in "${need[@]}"; do
  status="$(echo "$PM2_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(next((p['pm2_env']['status'] for p in d if p['name']=='$p'), 'missing'))" 2>/dev/null || echo "?")"
  if [[ "$status" == "online" ]]; then
    say "✓ $p online"
  else
    err "$p — $status"
  fi
done

# 2. API отвечает
deadline=$(( $(date +%s) + TIMEOUT ))
api_ok=false
while [[ $(date +%s) -lt $deadline ]]; do
  if curl -sf "http://127.0.0.1:${API_PORT}/api/health" -o /dev/null 2>/dev/null; then
    api_ok=true
    break
  fi
  sleep 1
done
if $api_ok; then say "✓ API /api/health 200"; else err "API не отвечает на :${API_PORT}/api/health за ${TIMEOUT}s"; fi

# 3. Web отвечает
web_ok=false
deadline=$(( $(date +%s) + TIMEOUT ))
while [[ $(date +%s) -lt $deadline ]]; do
  if curl -sf -o /dev/null "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null; then
    web_ok=true
    break
  fi
  sleep 1
done
if $web_ok; then say "✓ Web 200"; else err "Web не отвечает на :${WEB_PORT}/ за ${TIMEOUT}s"; fi

if [[ $fail -ne 0 ]]; then
  say "FAIL"
  exit 1
fi
say "OK"
