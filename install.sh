#!/usr/bin/env bash
# MACEAGENT installer
# Запуск:  bash install.sh   (не двойным кликом!)

# ── 0. откуда нас запустили ────────────────────────────────────────
# Если пользователь всё-таки кликнул двойным кликом на Linux/Mac —
# окно терминала откроется, но stdin может быть не-tty. Всё равно работаем.

set -uo pipefail   # БЕЗ -e: ошибки обрабатываем сами, чтобы успеть напечатать

GREEN=$'\033[0;32m'; PURPLE=$'\033[0;35m'; RED=$'\033[0;31m'
YELLOW=$'\033[0;33m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$NC" "$*"; }
err()  { printf '%s✗%s %s\n' "$RED" "$NC" "$*" >&2; }
info() { printf '%s◆%s %s\n' "$PURPLE" "$NC" "$*"; }
hr()   { printf '%s────────────────────────────────────────────────%s\n' "$CYAN" "$NC"; }

# Пауза перед выходом, если нас запустили не из живого терминала
PAUSE_ON_EXIT() {
  local rc=${1:-0}
  if [[ "$rc" -ne 0 ]]; then
    echo
    err "Установка прервана (код $rc). Скопируй сообщение выше в чат поддержки."
  fi
  # ждём Enter только если есть куда нажать
  if [[ -t 0 ]]; then
    echo
    read -r -p "Enter — закрыть окно..." _ || true
  elif [[ -r /dev/tty ]]; then
    echo
    read -r -p "Enter — закрыть окно..." _ </dev/tty || true
  fi
  exit "$rc"
}
trap 'PAUSE_ON_EXIT $?' EXIT

# ── 1. проверка исходников ────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
AGENT_SRC="${SCRIPT_DIR}/maceagent.ts"

if [[ ! -f "$AGENT_SRC" ]]; then
  err "maceagent.ts не найден рядом с install.sh"
  err "ожидал: $AGENT_SRC"
  err "положи install.sh и maceagent.ts в одну папку"
  exit 1
fi

INSTALL_DIR="${MACE_INSTALL_DIR:-$HOME/.local/share/maceagent}"
BIN_DIR="${MACE_BIN_DIR:-$HOME/.local/bin}"
ENV_TARGET="${INSTALL_DIR}/.env"
LAUNCHER="${BIN_DIR}/maceagent"

info "Установка MACEAGENT"
hr

# ── 2. рантайм ────────────────────────────────────────────────────
RUNTIME=""
if command -v bun >/dev/null 2>&1; then
  RUNTIME="bun"; ok "нашёл bun ($(bun --version))"
elif command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if (( NODE_MAJOR < 18 )); then
    err "нужен Node.js 18+ (у тебя $(node --version))"
    exit 1
  fi
  RUNTIME="node"; ok "нашёл node ($(node --version))"
else
  warn "ни bun, ни node не найдены в PATH"
  echo
  echo "  Поставь один из них:"
  echo "    • bun   — https://bun.sh   (быстрее, рекомендую)"
  echo "    • node  — https://nodejs.org  (18+)"
  echo
  err "установка отменена — сначала поставь рантайм"
  exit 1
fi

# ── 3. копируем агента ────────────────────────────────────────────
mkdir -p "$INSTALL_DIR" "$BIN_DIR" || { err "не могу создать $INSTALL_DIR"; exit 1; }
cp "$AGENT_SRC" "$INSTALL_DIR/maceagent.ts" || { err "не могу скопировать maceagent.ts"; exit 1; }
chmod +x "$INSTALL_DIR/maceagent.ts"
ok "maceagent.ts → $INSTALL_DIR/"

# ── 4. tsx для node ───────────────────────────────────────────────
if [[ "$RUNTIME" == "node" ]]; then
  if [[ ! -x "$INSTALL_DIR/node_modules/.bin/tsx" ]]; then
    info "устанавливаю tsx (TypeScript runner)"
    (
      cd "$INSTALL_DIR" || exit 1
      [[ -f package.json ]] || npm init -y >/dev/null 2>&1
      npm install --silent --no-fund --no-audit tsx 2>&1 | tail -5
    ) || { err "npm install tsx упал — проверь сеть / npm"; exit 1; }
    ok "tsx установлен"
  else
    ok "tsx уже есть"
  fi
fi

# ── 5. .env ───────────────────────────────────────────────────────
ENV_CREATED=0
if [[ ! -f "$ENV_TARGET" ]]; then
  cat >"$ENV_TARGET" <<'EOF'
# ═════════════════════════════════════════════════════════════════
#  MACEAGENT · .env
#  Впиши ключ хотя бы одного провайдера (можно несколько).
# ═════════════════════════════════════════════════════════════════

# Google Gemini — рекомендую (1M контекста, бесплатно)
# ключ: https://aistudio.google.com/apikey
GEMINI_API_KEY=

# Groq — быстрый, бесплатный
# GROQ_API_KEY=

# OpenRouter — много моделей, free tier
# OPENROUTER_API_KEY=

# Mistral — free tier
# MISTRAL_API_KEY=

# Anthropic — платный, качественный
# ANTHROPIC_API_KEY=

# ─── опционально ─────────────────────────────────────────────────
# MACE_PROVIDER=gemini
# MACE_MODEL=gemini-2.5-flash
# MACE_FAST=1
# MACE_TIMEOUT=60000
# MACE_REASONING=low
# MACE_CONTEXT=1000000
EOF
  chmod 600 "$ENV_TARGET" 2>/dev/null || true
  ok "создал .env → $ENV_TARGET"
  ENV_CREATED=1
else
  ok ".env уже есть — не трогаю"
fi

# ── 6. launcher ───────────────────────────────────────────────────
if [[ "$RUNTIME" == "bun" ]]; then
  cat >"$LAUNCHER" <<EOF
#!/usr/bin/env bash
exec bun "$INSTALL_DIR/maceagent.ts" "\$@"
EOF
else
  cat >"$LAUNCHER" <<EOF
#!/usr/bin/env bash
exec "$INSTALL_DIR/node_modules/.bin/tsx" "$INSTALL_DIR/maceagent.ts" "\$@"
EOF
fi
chmod +x "$LAUNCHER"
ok "launcher → $LAUNCHER"

# ── 7. PATH ───────────────────────────────────────────────────────
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR нет в PATH"
    SHELL_RC=""
    case "${SHELL:-}" in
      */zsh)  SHELL_RC="$HOME/.zshrc" ;;
      */bash) SHELL_RC="$HOME/.bashrc" ;;
      *)      SHELL_RC="$HOME/.profile" ;;
    esac
    if [[ -n "$SHELL_RC" && -f "$SHELL_RC" ]] && ! grep -q "MACEAGENT PATH" "$SHELL_RC" 2>/dev/null; then
      printf '\n# MACEAGENT PATH\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >>"$SHELL_RC"
      ok "добавил $BIN_DIR в $SHELL_RC (перезайди или: source $SHELL_RC)"
    else
      echo "  добавь вручную:  export PATH=\"$BIN_DIR:\$PATH\""
    fi
    ;;
esac

# ── 8. Anthropic SDK (опционально) ────────────────────────────────
if [[ "$RUNTIME" == "node" ]]; then
  warn "для Anthropic-провайдера понадобится SDK (сейчас НЕ ставил):"
  echo "     cd \"$INSTALL_DIR\" && npm install @anthropic-ai/sdk"
fi

# ── готово ────────────────────────────────────────────────────────
hr
ok "Готово!"
echo
if (( ENV_CREATED )); then
  echo "  ${CYAN}1. Открой${NC} $ENV_TARGET"
  echo "     и впиши ключ в ${PURPLE}GEMINI_API_KEY=${NC}"
  echo "     получить: ${CYAN}https://aistudio.google.com/apikey${NC}"
  echo
fi
echo "  ${CYAN}2. Запуск из любой папки:${NC}"
echo "     ${PURPLE}maceagent${NC}"
echo
echo "  ${CYAN}3. Внутри сессии:${NC}"
echo "     ${PURPLE}/test${NC}  ${PURPLE}/models${NC}  ${PURPLE}/limits${NC}  ${PURPLE}/help${NC}"
echo