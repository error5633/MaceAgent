#!/usr/bin/env bash
# MACEAGENT uninstaller — запуск: bash uninstall.sh
set -uo pipefail

RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; GREEN=$'\033[0;32m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$NC" "$*"; }
err()  { printf '%s✗%s %s\n' "$RED" "$NC" "$*" >&2; }
info() { printf '%s◆%s %s\n' "$CYAN" "$NC" "$*"; }

PAUSE_ON_EXIT() {
  local rc=${1:-0}
  if [[ -t 0 ]]; then echo; read -r -p "Enter — закрыть..." _ || true
  elif [[ -r /dev/tty ]]; then echo; read -r -p "Enter — закрыть..." _ </dev/tty || true; fi
  exit "$rc"
}
trap 'PAUSE_ON_EXIT $?' EXIT

INSTALL_DIR="${MACE_INSTALL_DIR:-$HOME/.local/share/maceagent}"
BIN_DIR="${MACE_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER="${BIN_DIR}/maceagent"

info "Удаление MACEAGENT"
echo

# подтверждение
if [[ -t 0 ]]; then
  read -r -p "Удалить $INSTALL_DIR и $LAUNCHER? [y/N] " ans
  [[ "${ans:-}" =~ ^[Yy]$ ]] || { warn "отменено"; exit 0; }
fi

# launcher
if [[ -e "$LAUNCHER" ]]; then
  rm -f "$LAUNCHER" && ok "удалён $LAUNCHER"
else
  warn "launcher не найден: $LAUNCHER"
fi

# install dir (с ключами!)
if [[ -d "$INSTALL_DIR" ]]; then
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    warn "в $INSTALL_DIR/.env может быть твой API-ключ"
    if [[ -t 0 ]]; then
      read -r -p "Удалить вместе с .env? [y/N] " ans2
      if [[ ! "${ans2:-}" =~ ^[Yy]$ ]]; then
        cp "$INSTALL_DIR/.env" "$HOME/maceagent.env.backup"
        ok "ключи сохранены: $HOME/maceagent.env.backup"
      fi
    fi
  fi
  rm -rf "$INSTALL_DIR" && ok "удалён $INSTALL_DIR"
else
  warn "папка не найдена: $INSTALL_DIR"
fi

# PATH из shell rc
for RC in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  if [[ -f "$RC" ]] && grep -q "MACEAGENT PATH" "$RC" 2>/dev/null; then
    # удаляем строку-маркер и следующую export-строку
    if sed --version >/dev/null 2>&1; then
      sed -i '/# MACEAGENT PATH/,+1d' "$RC" 2>/dev/null
    else
      sed -i '' '/# MACEAGENT PATH/,+1d' "$RC" 2>/dev/null
    fi
    ok "убрал PATH из $RC"
  fi
done

echo
ok "Готово. MACEAGENT удалён."
echo "  Перезайди в shell или выполни: hash -r"