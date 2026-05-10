#!/usr/bin/env bash
# =============================================================================
# Rollback — откат панели на предыдущий релиз / снапшот.
#
# Usage:
#   bash tools/rollback.sh                    # откат на предыдущий релиз
#   bash tools/rollback.sh release <name>     # на конкретный релиз
#   bash tools/rollback.sh snapshot <name>    # восстановление БД + .env из снапшота
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="$(dirname "$SCRIPT_DIR")"
RELEASES_DIR="$PANEL_DIR/releases"
STATE_DIR="${MEOWBOX_STATE_DIR:-$PANEL_DIR/state}"
[[ -d "$STATE_DIR" ]] || STATE_DIR="$PANEL_DIR"
DATA_DIR="$STATE_DIR/data"
[[ -d "$DATA_DIR" ]] || DATA_DIR="$PANEL_DIR/data"
SNAP_ROOT="$DATA_DIR/snapshots"

say() { echo "[rollback] $*"; }
err() { echo "[rollback] ✗ $*" >&2; exit 1; }

# ----- Dev-mode guard -----
if [[ -f "$PANEL_DIR/.dev-mode" ]]; then
  echo "❌ Это dev-сервер (.dev-mode). rollback.sh оперирует releases/ — на dev это сломает git workspace."
  echo "   Откат на dev = 'git checkout <commit>' + 'make dev' (rebuild)."
  exit 1
fi

mode="${1:-release}"
target="${2:-}"

case "$mode" in
  release)
    [[ -d "$RELEASES_DIR" ]] || err "Релизной структуры нет ($RELEASES_DIR не существует) — rollback в этом режиме невозможен"
    [[ -L "$PANEL_DIR/current" ]] || err "Симлинк current отсутствует"
    current_target="$(readlink -f "$PANEL_DIR/current")"
    current_name="$(basename "$current_target")"

    if [[ -n "$target" ]]; then
      tgt_dir="$RELEASES_DIR/$target"
    else
      # предыдущий = последний release ≠ текущий
      tgt_dir=""
      for d in $(ls -1t "$RELEASES_DIR"); do
        if [[ "$d" != "$current_name" ]]; then
          tgt_dir="$RELEASES_DIR/$d"
          break
        fi
      done
      [[ -n "$tgt_dir" ]] || err "Нет других релизов в $RELEASES_DIR"
    fi
    [[ -d "$tgt_dir" ]] || err "Релиз $tgt_dir не найден"

    say "Switching current: $current_name → $(basename "$tgt_dir")"
    ln -sfn "$tgt_dir" "$PANEL_DIR/current"
    pm2 reload "$PANEL_DIR/ecosystem.config.js" --update-env
    sleep 5
    bash "$SCRIPT_DIR/healthcheck.sh"
    say "OK: rolled back to $(basename "$tgt_dir")"
    ;;

  snapshot)
    [[ -n "$target" ]] || err "Usage: rollback.sh snapshot <snapshot-name>"
    snap_dir="$SNAP_ROOT/$target"
    [[ -d "$snap_dir" ]] || err "Snapshot $snap_dir не найден"

    say "Останавливаю PM2 для безопасной замены БД..."
    pm2 stop meowbox-api meowbox-web meowbox-agent || true

    if [[ -f "$snap_dir/meowbox.db" ]]; then
      cp "$snap_dir/meowbox.db" "$DATA_DIR/meowbox.db"
      say "✓ meowbox.db restored"
    fi
    if [[ -f "$snap_dir/.env" ]]; then
      ENV_FILE="$STATE_DIR/.env"
      [[ -d "$STATE_DIR" && "$STATE_DIR" != "$PANEL_DIR" ]] || ENV_FILE="$PANEL_DIR/.env"
      cp "$snap_dir/.env" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      say "✓ .env restored"
    fi
    if [[ -f "$snap_dir/servers.json" ]]; then
      cp "$snap_dir/servers.json" "$DATA_DIR/servers.json"
      say "✓ servers.json restored"
    fi

    pm2 start "$PANEL_DIR/ecosystem.config.js" || pm2 reload "$PANEL_DIR/ecosystem.config.js"
    sleep 5
    bash "$SCRIPT_DIR/healthcheck.sh"
    say "OK: snapshot $target restored"
    ;;

  *)
    err "Неизвестный режим: $mode. Используй: release | snapshot"
    ;;
esac
