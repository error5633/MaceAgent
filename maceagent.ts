#!/usr/bin/env node
/**
 * MACEAGENT — terminal AI agent · purple edition v0.2
 * Run:  bun maceagent.ts   or:  npx tsx maceagent.ts
 *
 * .env (рядом с файлом или в текущей папке):
 *   GEMINI_API_KEY=AIzaSy...        (GOOGLE_API_KEY тоже подойдёт)
 *   MACE_PROVIDER=gemini
 *   MACE_MODEL=gemini-3.6-flash
 *   MACE_FAST=1            (опционально — пропустить анимацию)
 *   MACE_TIMEOUT=60000     (опционально — таймаут ответа в мс)
 *   MACE_REASONING=low     (опционально, Gemini: minimal|low|medium|high)
 *   MACE_BASE_URL=...      (опционально — свой прокси / OpenAI-совместимый endpoint)
 *   MACE_CONTEXT=1000000   (опционально — размер контекстного окна в токенах для проверки)
 */
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, join, relative, sep } from "node:path";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ═════════ .env loader (cwd + рядом со скриптом) ═════════
function loadEnv(file: string) {
  try {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch { /* .env не обязателен */ }
}
loadEnv(resolve(process.cwd(), ".env"));
if (process.argv[1]) loadEnv(resolve(dirname(process.argv[1]), ".env"));
if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;

// ═════════ tunables ═════════
const IS_TTY = !!stdout.isTTY;
const FAST_MODE = !IS_TTY || process.env.MACE_FAST === "1" || process.env.MACE_FAST === "true";
const REQ_TIMEOUT_MS = parseInt(process.env.MACE_TIMEOUT || "60000", 10);
const REASONING = (process.env.MACE_REASONING || "").toLowerCase();
const SHIMMER_FRAMES = FAST_MODE ? 0 : 22;
const SHIMMER_DELAY = 22;
const MAX_TOOL_RESULT = 30_000;   // сколько символов результата инструмента уходит в модель
const CTX_WARN = 0.75;            // предупреждение, когда контекст заполнен на 75%
const CTX_BLOCK = 0.95;           // запрос не отправляется, когда контекст заполнен на 95%

// ═════════ color system ═════════
const COLORTERM = process.env.COLORTERM || "";
const NO_COLOR = process.env.NO_COLOR !== undefined;
const FORCE = process.env.FORCE_COLOR;

type ColorMode = "truecolor" | "256" | "none";
const COLOR_MODE: ColorMode = (() => {
  if (NO_COLOR || FORCE === "0") return "none";
  if (FORCE === "3" || /truecolor|24bit/i.test(COLORTERM)) return "truecolor";
  if (FORCE === "2") return "256";
  if (!IS_TTY && !FORCE) return "none";
  return "truecolor";
})();

function rgbTo256(r: number, g: number, b: number): number {
  if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}
const clamp8 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function fg(r: number, g: number, b: number): string {
  if (COLOR_MODE === "none") return "";
  r = clamp8(r); g = clamp8(g); b = clamp8(b);
  return COLOR_MODE === "truecolor" ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
}
function bg(r: number, g: number, b: number): string {
  if (COLOR_MODE === "none") return "";
  r = clamp8(r); g = clamp8(g); b = clamp8(b);
  return COLOR_MODE === "truecolor" ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${rgbTo256(r, g, b)}m`;
}

const sgr = (code: string) => (COLOR_MODE === "none" ? "" : `\x1b[${code}m`);
const RESET = sgr("0"), BOLD = sgr("1"), DIM = sgr("2"), ITALIC = sgr("3");

const parseHex = (h: string): [number, number, number] =>
  [h.slice(1, 3), h.slice(3, 5), h.slice(5, 7)].map(x => parseInt(x, 16)) as [number, number, number];
const fgH = (h: string) => fg(...parseHex(h));
const bgH = (h: string) => bg(...parseHex(h));
const hex = (h: string, s: string): string => (COLOR_MODE === "none" ? s : `${fgH(h)}${s}${RESET}`);
const bold = (h: string, s: string): string => (COLOR_MODE === "none" ? s : `${BOLD}${fgH(h)}${s}${RESET}`);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const out = (s = "") => stdout.write(s + "\n");
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const strip = (s: string) => s.replace(ANSI_RE, "");
const visLen = (s: string) => [...strip(s)].length;
const cols = () => Math.max(40, Math.min(stdout.columns || 80, 120));
const clip = (s: string, n: number) => {
  const a = [...s];
  return a.length > n ? a.slice(0, Math.max(0, n - 1)).join("") + "…" : s;
};

function gradient(text: string, from: string, to: string, isBold = false): string {
  if (COLOR_MODE === "none") return text;
  const [r1, g1, b1] = parseHex(from), [r2, g2, b2] = parseHex(to);
  const chars = [...text];
  const n = Math.max(1, chars.length - 1);
  let s = isBold ? BOLD : "";
  chars.forEach((ch, i) => {
    const t = i / n;
    s += ch === " " ? " " : fg(lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t)) + ch;
  });
  return s + RESET;
}

process.on("exit", () => { if (IS_TTY) stdout.write("\x1b[?25h"); });

// ═════════ palette ═════════
const P = {
  v900: "#4C1D95", v800: "#5B21B6", v700: "#6D28D9", v600: "#7C3AED",
  v500: "#8B5CF6", v400: "#A78BFA", v300: "#C4B5FD", v200: "#DDD6FE", v100: "#F5F3FF",
  f400: "#E879F9", f500: "#D946EF",
  codeBg: "#2E1065", codeFg: "#F0ABFC",
  ok: "#86EFAC", err: "#F87171", mute: "#6B5B95",
};

// ═════════ providers ═════════
interface Provider {
  name: string;
  baseUrl: string;
  defaultModel: string;
  fallbackModels?: string[];
  keyEnv: string;
  free: boolean;
  contextWindow: number;   // токенов
}

const PROVIDERS: Record<string, Provider> = {
  anthropic: {
    name: "Anthropic",
    baseUrl: "",
    defaultModel: "claude-sonnet-4-5",
    keyEnv: "ANTHROPIC_API_KEY",
    free: false,
    contextWindow: 200_000,
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/free",
    keyEnv: "OPENROUTER_API_KEY",
    free: true,
    contextWindow: 128_000,
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    fallbackModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    keyEnv: "GROQ_API_KEY",
    free: true,
    contextWindow: 128_000,
  },
  gemini: {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.6-flash",
    // от самой умной к самой лёгкой — у каждой модели своя квота
    fallbackModels: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"],
    keyEnv: "GEMINI_API_KEY",
    free: true,
    contextWindow: 1_000_000,
  },
  mistral: {
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    keyEnv: "MISTRAL_API_KEY",
    free: true,
    contextWindow: 128_000,
  },
};

// ═════════ команды (для /help и подсказок после «/») ═════════
interface CmdDef { name: string; desc: string; usage?: string }
const COMMANDS: CmdDef[] = [
  { name: "/help",     desc: "список команд" },
  { name: "/clear",    desc: "очистить экран" },
  { name: "/reset",    desc: "сбросить диалог" },
  { name: "/provider", desc: "список / смена провайдера", usage: "/provider <name>" },
  { name: "/model",    desc: "показать / сменить модель", usage: "/model <name>" },
  { name: "/models",   desc: "модели, доступные твоему ключу (live)" },
  { name: "/limits",   desc: "остатки лимитов и когда они восстановятся" },
  { name: "/tokens",   desc: "расход токенов и заполнение контекста" },
  { name: "/test",     desc: "проверить ключ и модели" },
  { name: "/cwd",      desc: "показать / сменить папку", usage: "/cwd <path>" },
  { name: "/tools",    desc: "список инструментов" },
  { name: "/colors",   desc: "режим цвета + палитра" },
  { name: "/exit",     desc: "выйти" },
];

// ═════════ токены ═════════
/** Грубая оценка: ~3.2 символа на токен (смесь кода, английского и русского). */
const estimateTokens = (s: string) => Math.ceil(s.length / 3.2);
const fmtTok = (n: number) => n >= 1_000_000 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(Math.round(n));
interface Usage { prompt: number; completion: number }

// ═════════ rate helpers ═════════
/** "2m59.56s" · "1h2m" · "180ms" · "7.5" (секунды) → миллисекунды */
function parseDur(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const t = s.trim().replace(/\.$/, "");
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/g;
  let ms = 0, found = false, m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    found = true;
    const v = parseFloat(m[1]);
    ms += m[2] === "ms" ? v : m[2] === "s" ? v * 1000 : m[2] === "m" ? v * 60_000 : m[2] === "h" ? v * 3_600_000 : v * 86_400_000;
  }
  return found ? ms : undefined;
}
/** 8100000 → "2ч 15м" */
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}м ${s % 60}с`.replace(/ 0с$/, "");
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}ч ${m % 60}м`.replace(/ 0м$/, "");
  return `${Math.floor(h / 24)}д ${h % 24}ч`;
}
/** «через ms» → «18:42» / «завтра 03:00» / «15.11 03:00» */
function fmtWhen(ms: number): string {
  const d = new Date(Date.now() + Math.max(0, ms));
  const t = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t;
  if (d.toDateString() === new Date(now.getTime() + 86_400_000).toDateString()) return `завтра ${t}`;
  return `${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${t}`;
}
/** сколько мс до 00:00 по Тихоокеанскому времени (сброс дневной квоты Gemini) */
function msToPacificMidnight(): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? "0", 10);
  return (86_400 - ((g("hour") % 24) * 3600 + g("minute") * 60 + g("second"))) * 1000;
}
/** сколько мс до 00:00 UTC */
function msToUtcMidnight(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime();
}
// ═════════ end rate helpers ═════════

// ═════════ ANSI Shadow font ═════════
const FONT: Record<string, string[]> = {
  M: ["███╗   ███╗","████╗ ████║","██╔████╔██║","██║╚██╔╝██║","██║ ╚═╝ ██║","╚═╝     ╚═╝"],
  A: [" █████╗ ","██╔══██╗","███████║","██╔══██║","██║  ██║","╚═╝  ╚═╝"],
  C: [" ██████╗","██╔════╝","██║     ","██║     ","╚██████╗"," ╚═════╝"],
  E: ["███████╗","██╔════╝","█████╗  ","██╔══╝  ","███████╗","╚══════╝"],
  G: [" ██████╗ ","██╔════╝ ","██║  ███╗","██║   ██║","╚██████╔╝"," ╚═════╝ "],
  N: ["███╗   ██╗","████╗  ██║","██╔██╗ ██║","██║╚██╗██║","██║ ╚████║","╚═╝  ╚═══╝"],
  T: ["████████╗","╚══██╔══╝","   ██║   ","   ██║   ","   ██║   ","   ╚═╝   "],
};
function buildBlock(text: string): string[] {
  const rows = ["", "", "", "", "", ""];
  for (let i = 0; i < text.length; i++) {
    const L = FONT[text[i]];
    if (!L) continue;
    for (let r = 0; r < 6; r++) rows[r] += L[r] + (i < text.length - 1 ? " " : "");
  }
  return rows;
}

function logoLine(line: string, y: number, H: number, f: number | null): string {
  let s = "  ";
  for (let x = 0; x < line.length; x++) {
    const ch = line[x];
    if (ch === " ") { s += " "; continue; }
    let r: number, g: number, b: number;
    if (f === null) {
      const t = (x / line.length) * 0.7 + (y / H) * 0.3;
      r = lerp(91, 232, t); g = lerp(33, 121, t); b = lerp(182, 249, t);
    } else {
      const k = (Math.sin(x * 0.18 + y * 0.5 - f * 0.6) + 1) / 2;
      r = lerp(76, 232, k); g = lerp(29, 160, k); b = lerp(149, 254, k);
    }
    s += `${BOLD}${fg(r, g, b)}${ch}`;
  }
  return s + RESET;
}

async function drawLogo(animate: boolean) {
  if ((stdout.columns || 80) < 92) {
    out("  " + gradient("◆  M A C E A G E N T  ◆", P.v700, P.f400, true));
    return;
  }
  const rows = buildBlock("MACEAGENT");
  const H = rows.length;
  const frame = (f: number | null) => rows.map((l, y) => "\r" + logoLine(l, y, H, f)).join("\n") + "\n";
  if (!animate || SHIMMER_FRAMES === 0) { stdout.write(frame(null)); return; }
  stdout.write("\x1b[?25l");
  for (let f = 0; f < SHIMMER_FRAMES; f++) {
    if (f > 0) stdout.write(`\x1b[${H}A`);
    stdout.write(frame(f));
    await sleep(SHIMMER_DELAY);
  }
  stdout.write(`\x1b[${H}A`);
  stdout.write(frame(null));
  stdout.write("\x1b[?25h");
}

// ═════════ box ═════════
function box(lines: string[]): string[] {
  const inner = Math.min(cols() - 6, 66);
  const edge = (l: string, r: string) => "  " + gradient(l + "─".repeat(inner + 2) + r, P.v700, P.f400);
  const side = hex(P.v600, "│");
  const res = [edge("╭", "╮")];
  for (const l of lines) {
    res.push(`  ${side} ${l}${" ".repeat(Math.max(0, inner - visLen(l)))} ${side}`);
  }
  res.push(edge("╰", "╯"));
  return res;
}

// ═════════ spinner ═════════
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
class Spinner {
  private t?: ReturnType<typeof setInterval>;
  private i = 0;
  private running = false;
  private t0 = 0;
  start(msg: string) {
    this.stop();
    if (!IS_TTY) return;
    this.running = true; this.i = 0; this.t0 = Date.now();
    stdout.write("\x1b[?25l");
    const render = () => {
      const phase = (Math.sin(this.i / 4) + 1) / 2;
      const c = fg(lerp(124, 232, phase), lerp(58, 121, phase), lerp(237, 249, phase));
      const secs = Math.floor((Date.now() - this.t0) / 1000);
      const time = secs >= 2 ? ` ${hex(P.mute, secs + "s")}` : "";
      stdout.write(`\r\x1b[2K  ${c}${SPIN_FRAMES[this.i % SPIN_FRAMES.length]} ${msg}${RESET}${time}`);
      this.i++;
    };
    render();
    this.t = setInterval(render, 80);
  }
  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.t) clearInterval(this.t);
    stdout.write("\r\x1b[2K\x1b[?25h");
  }
}

// ═════════ markdown stream renderer ═════════
/** Рисует markdown по мере поступления токенов: **bold**, *italic*, `code`, ``` блоки, # заголовки, списки. */
class MdStream {
  private pending = "";
  private lineStart = true;
  private indented = false;
  private fence = false;
  private isBold = false;
  private isItalic = false;
  private isCode = false;
  private header = 0;
  private prev = "\n";
  private buf = "";
  printed = false;

  private style(): string {
    if (COLOR_MODE === "none") return "";
    if (this.isCode) return `${RESET}${bgH(P.codeBg)}${fgH(P.codeFg)}`;
    if (this.header) return `${RESET}${BOLD}${fgH(this.header === 1 ? P.f400 : P.v300)}`;
    let s = RESET;
    if (this.isBold) s += BOLD;
    if (this.isItalic) s += ITALIC;
    return s + fgH(this.isBold ? P.v100 : this.isItalic ? P.v300 : P.v200);
  }
  private rule(l: string, r: string, lang = ""): string {
    const w = Math.max(10, Math.min(cols() - 4, 72));
    const label = lang ? ` ${lang} ` : "";
    return `${RESET}  ${hex(P.v700, l + "─")}${lang ? hex(P.f400, label) : ""}${hex(P.v700, "─".repeat(Math.max(2, w - 2 - label.length)) + r)}`;
  }

  write(s: string) {
    if (!s) return;
    this.printed = true;
    this.pending += s;
    this.drain(false);
  }
  end() {
    this.drain(true);
    if (this.fence) { this.buf += (this.indented ? "\n" : "") + this.rule("╰", ""); this.buf += "\n"; this.fence = false; }
    else if (this.indented) this.buf += RESET + "\n";
    this.buf += RESET;
    this.flush();
  }
  private flush() { if (this.buf) { stdout.write(this.buf); this.buf = ""; } }

  private drain(final: boolean) {
    const s = this.pending;
    let i = 0;
    const emit = (x: string) => { this.buf += x; };
    const startLine = () => { if (!this.indented) { emit("  " + this.style()); this.indented = true; } };
    const newline = () => { emit(RESET + "\n"); this.lineStart = true; this.indented = false; this.prev = "\n"; };

    loop: while (i < s.length) {
      const c = s[i];
      const rest = s.length - i;

      // ── inside ``` block ──
      if (this.fence) {
        if (!this.indented) {
          if (c === "`") {
            if (s.startsWith("```", i)) {
              const nl = s.indexOf("\n", i);
              if (nl === -1 && !final) break loop;
              emit(this.rule("╰", "") + "\n");
              this.fence = false; this.lineStart = true;
              i = nl === -1 ? s.length : nl + 1;
              continue;
            }
            if (rest < 3 && "```".startsWith(s.slice(i)) && !final) break loop;
          }
          emit(`${RESET}  ${hex(P.v700, "│")} ${fgH(P.v200)}`);
          this.indented = true;
        }
        if (c === "\n") { emit(RESET + "\n"); this.indented = false; } else emit(c);
        i++;
        continue;
      }

      // ── line start constructs ──
      if (this.lineStart) {
        if (c === "`") {
          if (s.startsWith("```", i)) {
            const nl = s.indexOf("\n", i);
            if (nl === -1 && !final) break loop;
            const lang = s.slice(i + 3, nl === -1 ? s.length : nl).trim();
            emit(this.rule("╭", "", lang) + "\n");
            this.fence = true; this.lineStart = true; this.indented = false;
            i = nl === -1 ? s.length : nl + 1;
            continue;
          }
          if (rest < 3 && "```".startsWith(s.slice(i)) && !final) break loop;
        }
        if (c === "#") {
          const m = /^(#{1,6}) /.exec(s.slice(i, i + 8));
          if (m) {
            this.header = m[1].length === 1 ? 1 : 2;
            startLine();
            emit(this.style() + (this.header === 1 ? "▍ " : ""));
            i += m[0].length; this.lineStart = false;
            continue;
          }
          if (rest <= 6 && /^#{1,6}$/.test(s.slice(i)) && !final) break loop;
        }
        if (c === "-" || c === "*" || c === "+") {
          if (rest < 2 && !final) break loop;
          if (s[i + 1] === " ") {
            startLine();
            emit(`${RESET}${fgH(P.f400)}•${this.style()} `);
            i += 2; this.lineStart = false; this.prev = " ";
            continue;
          }
        }
        if (c === " ") { startLine(); emit(" "); i++; continue; }
      }

      if (c === "\n") {
        this.header = 0; this.isItalic = false; this.isCode = false;
        newline();
        i++;
        continue;
      }

      startLine();
      this.lineStart = false;

      // ── inline code ──
      if (this.isCode) {
        if (c === "`") { emit(" "); this.isCode = false; emit(this.style()); }
        else emit(c);
        this.prev = c; i++;
        continue;
      }
      if (c === "`") { this.isCode = true; emit(this.style() + " "); this.prev = c; i++; continue; }

      // ── bold / italic ──
      if (c === "*") {
        if (rest < 2 && !final) break loop;
        if (s[i + 1] === "*") { this.isBold = !this.isBold; emit(this.style()); i += 2; this.prev = "*"; continue; }
        const next = s[i + 1] ?? " ";
        if (!this.isItalic && next !== " " && next !== "\n" && /[\s(\[]/.test(this.prev)) {
          this.isItalic = true; emit(this.style()); i++; this.prev = "*"; continue;
        }
        if (this.isItalic && !/\s/.test(this.prev)) {
          this.isItalic = false; emit(this.style()); i++; this.prev = "*"; continue;
        }
      }

      emit(c);
      this.prev = c;
      i++;
    }
    this.pending = s.slice(i);
    this.flush();
  }
}

// ═════════ types ═════════
interface ToolCall { id: string; name: string; arguments: string; extra?: any }
type HistoryEntry =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls: ToolCall[]; model: string }
  | { role: "tool"; toolCallId: string; name: string; result: string };
type ToolFn = (input: any) => string | Promise<string>;
interface Completion { text: string; toolCalls: ToolCall[]; finish?: string; printed: boolean; usage?: Usage }

// ═════════ errors ═════════
class ApiError extends Error {
  status: number;
  retryAfterMs?: number;
  kind: "http" | "network" | "timeout";
  daily: boolean;      // исчерпан дневной лимит
  constructor(status: number, message: string, opts: { retryAfterMs?: number; kind?: "http" | "network" | "timeout"; daily?: boolean } = {}) {
    super(message);
    this.status = status;
    this.daily = !!opts.daily;
    this.retryAfterMs = opts.retryAfterMs;
    this.kind = opts.kind ?? "http";
  }
}
class Interrupted extends Error {}

/** Разбирает тело ошибки (у Gemini это JSON-массив `[{error:{...}}]`). */
function parseApiError(status: number, statusText: string, body: string, headers?: Headers): ApiError {
  let msg = body.trim();
  let retry: number | undefined;
  let daily = false;
  try {
    let j = JSON.parse(body);
    if (Array.isArray(j)) j = j[0];
    const e = j?.error ?? j;
    if (e?.message) msg = String(e.message);
    if (Array.isArray(e?.details)) {
      for (const d of e.details) {
        if (Array.isArray(d?.violations) && d.violations.some((v: any) => /per.?day/i.test(String(v?.quotaId ?? "")))) daily = true;
        if (typeof d?.retryDelay === "string") {
          const m = d.retryDelay.match(/([\d.]+)s/);
          if (m) retry = parseFloat(m[1]) * 1000;
        }
      }
    }
  } catch { /* не JSON */ }
  if (retry === undefined) {
    const m = msg.match(/retry in ([\d.]+)s/i);
    if (m) retry = parseFloat(m[1]) * 1000;
  }
  if (retry === undefined) {                       // Groq: "Please try again in 7m12.5s"
    const m = msg.match(/try again in ([0-9.dhms]+)/i);
    if (m) retry = parseDur(m[1]);
  }
  if (/per.?day|daily|\((?:TPD|RPD)\)/i.test(msg)) daily = true;
  const ra = headers?.get("retry-after");
  if (retry === undefined && ra && !isNaN(Number(ra))) retry = Number(ra) * 1000;
  msg = msg.replace(/\s+/g, " ").slice(0, 300);
  return new ApiError(status, msg || statusText, { retryAfterMs: retry, daily });
}

// ═════════ fetch с таймаутом и отменой ═════════
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, userSignal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  userSignal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (userSignal?.aborted) throw new Interrupted();
    if (timedOut) throw new ApiError(0, `нет ответа за ${Math.round(timeoutMs / 1000)}с`, { kind: "timeout" });
    const code = e?.cause?.code ? ` (${e.cause.code})` : "";
    throw new ApiError(0, `${e?.message || e}${code}`, { kind: "network" });
  } finally {
    clearTimeout(timer);
  }
}

// ═════════ glob helpers ═════════
function expandBraces(p: string): string[] {
  const m = p.match(/\{([^{}]*)\}/);
  if (!m || m.index === undefined) return [p];
  return m[1].split(",").flatMap(opt => expandBraces(p.slice(0, m.index!) + opt + p.slice(m.index! + m[0].length)));
}
function globToRe(p: string): RegExp {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") { i++; if (p[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function runShell(cmd: string, cwd: string, signal?: AbortSignal): Promise<{ text: string; code: number; aborted: boolean; timedOut: boolean }> {
  return new Promise(res => {
    const child = exec(cmd, { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, signal, encoding: "utf8" }, (err, so, se) => {
      const text = [so, se].filter(Boolean).join(so && se ? "\n" : "").trim();
      if (!err) return res({ text, code: 0, aborted: false, timedOut: false });
      const e = err as any;
      res({
        text,
        code: typeof e.code === "number" ? e.code : 1,
        aborted: e.name === "AbortError",
        timedOut: !!e.killed && e.name !== "AbortError",
      });
    });
    child.stdin?.end();
  });
}

const isErrorResult = (r: string) => /^Error/.test(r) || /\[(exit code [1-9]\d*|timed out)\]\s*$/.test(r);

const TOOL_META: Record<string, { icon: string; color: string }> = {
  Read: { icon: "◉", color: P.v400 },
  Write: { icon: "◆", color: P.f400 },
  Edit: { icon: "◆", color: P.f500 },
  Bash: { icon: "❯", color: "#C084FC" },
  Glob: { icon: "◈", color: P.v300 },
  Grep: { icon: "◇", color: P.v300 },
};

// ═════════ agent ═════════
interface RateInfo {
  at: number;
  limitReq?: number; remReq?: number; resetReqAt?: number;
  limitTok?: number; remTok?: number; resetTokAt?: number;
}

class MaceAgent {
  private providerKey: string;
  private provider: Provider;
  private model: string;
  private cwd = process.cwd();
  private history: HistoryEntry[] = [];
  private rl = createInterface({
    input: stdin, output: stdout,
    completer: (line: string): [string[], string] => MaceAgent.completeCmd(line),
  });
  private busy = false;
  private ctrl: AbortController | null = null;

  // токены
  private total = { prompt: 0, completion: 0, calls: 0 };   // за сессию
  private turnUsage = { prompt: 0, completion: 0, calls: 0, estimated: false };
  private lastPrompt = 0;          // размер последнего промпта (реальный или оценка)
  private lastPromptReal = false;
  private warnedCtx = false;

  // лимиты: последние заголовки ответа по провайдеру и «заблокированные» модели (провайдер:модель → когда вернутся)
  private rate: Record<string, RateInfo> = {};
  private blocked: Record<string, { until: number; why: string }> = {};

  // живые списки моделей (GET /models), по ключу провайдера
  private liveModels: Record<string, string[]> = {};

  // подсказки после «/»
  private prompting = false;
  private hintRows = 0;

  private tools: Record<string, ToolFn> = {
    Read:  (i) => this.tRead(this.need(i, "path")),
    Write: (i) => this.tWrite(this.need(i, "path"), String(i.content ?? "")),
    Edit:  (i) => this.tEdit(this.need(i, "path"), String(i.old_string ?? ""), String(i.new_string ?? "")),
    Bash:  (i) => this.tBash(this.need(i, "command")),
    Glob:  (i) => this.tGlob(this.need(i, "pattern")),
    Grep:  (i) => this.tGrep(this.need(i, "pattern"), typeof i.path === "string" && i.path ? i.path : "."),
  };

  constructor() {
    const envProvider = (process.env.MACE_PROVIDER || "").toLowerCase();
    const detected = this.detectProvider(envProvider);
    if (detected) {
      this.providerKey = detected;
      this.provider = PROVIDERS[detected];
      this.model = process.env.MACE_MODEL || this.provider.defaultModel;
    } else {
      this.providerKey = "demo";
      this.provider = { name: "Demo", baseUrl: "", defaultModel: "demo", keyEnv: "", free: true, contextWindow: 0 };
      this.model = "demo";
    }
  }

  private detectProvider(preferred = ""): string | null {
    if (preferred && PROVIDERS[preferred] && process.env[PROVIDERS[preferred].keyEnv]) return preferred;
    for (const [key, p] of Object.entries(PROVIDERS)) {
      if (p.free && process.env[p.keyEnv]) return key;
    }
    if (process.env[PROVIDERS.anthropic.keyEnv]) return "anthropic";
    return null;
  }

  private get apiKey(): string {
    return this.providerKey === "demo" ? "" : (process.env[this.provider.keyEnv] || "").trim();
  }
  private get baseUrl(): string {
    return (process.env.MACE_BASE_URL || this.provider.baseUrl).replace(/\/$/, "");
  }

  private get ctxWindow(): number {
    const env = parseInt(process.env.MACE_CONTEXT || "", 10);
    return env > 0 ? env : this.provider.contextWindow;
  }

  /** Оценка размера следующего запроса: system + история + схемы инструментов. */
  private estimatePrompt(): number {
    let chars = this.systemPrompt().length + JSON.stringify(this.toolSchemasOpenAI()).length;
    for (const h of this.history) {
      if (h.role === "user") chars += h.content.length;
      else if (h.role === "tool") chars += h.result.length + h.name.length;
      else chars += (h.content?.length ?? 0) + h.toolCalls.reduce((a, t) => a + t.name.length + t.arguments.length, 0);
    }
    return Math.ceil(chars / 3.2);
  }

  /** Проверка перед запросом. false — отправлять нельзя. */
  private checkTokens(): boolean {
    const win = this.ctxWindow;
    if (!win) return true;
    const est = this.estimatePrompt();
    const ratio = est / win;
    if (ratio >= CTX_BLOCK) {
      out(`  ${hex(P.err, "✗")} ${hex(P.err, `контекст переполнен: ~${fmtTok(est)} из ${fmtTok(win)} токенов (${Math.round(ratio * 100)}%)`)}`);
      out(`  ${hex(P.v500, "Начни заново:")} ${hex(P.f400, "/reset")}${hex(P.mute, " · или увеличь MACE_CONTEXT, если окно модели больше")}`);
      return false;
    }
    if (ratio >= CTX_WARN && !this.warnedCtx) {
      this.warnedCtx = true;
      this.note(`⚠ контекст заполнен на ${Math.round(ratio * 100)}% (~${fmtTok(est)} из ${fmtTok(win)}) — скоро пригодится /reset`);
    }
    return true;
  }

  private addUsage(r: Completion) {
    const u = r.usage;
    this.turnUsage.calls++;
    if (u && (u.prompt || u.completion)) {
      this.turnUsage.prompt += u.prompt; this.turnUsage.completion += u.completion;
      this.lastPrompt = u.prompt + u.completion; this.lastPromptReal = true;
    } else {
      // провайдер не вернул usage — считаем сами
      const p = this.estimatePrompt(), c = estimateTokens(r.text + r.toolCalls.map(t => t.arguments).join(""));
      this.turnUsage.prompt += p; this.turnUsage.completion += c; this.turnUsage.estimated = true;
      this.lastPrompt = p + c; this.lastPromptReal = false;
    }
  }

  private bar(ratio: number, width = 24): string {
    const f = Math.max(0, Math.min(width, Math.round(ratio * width)));
    const col = ratio >= CTX_BLOCK ? P.err : ratio >= CTX_WARN ? P.f500 : P.v500;
    return hex(col, "█".repeat(f)) + hex(P.v800, "░".repeat(width - f));
  }

  private printTurnUsage() {
    const t = this.turnUsage;
    if (!t.calls || (!t.prompt && !t.completion)) return;
    this.total.prompt += t.prompt; this.total.completion += t.completion; this.total.calls += t.calls;
    const win = this.ctxWindow;
    const tilde = t.estimated ? "~" : "";
    const ctx = win ? ` ${hex(P.v700, "·")} ${hex(P.mute, "context")} ${hex(P.v400, `${Math.max(1, Math.round((this.lastPrompt / win) * 100))}%`)}` : "";
    const r = this.rate[this.providerKey];
    let lim = "";
    if (r && Date.now() - r.at < 120_000 && r.remTok !== undefined && r.limitTok && r.remTok / r.limitTok < 0.25) {
      lim = ` ${hex(P.v700, "·")} ${hex(P.f500, `лимит: осталось ${fmtTok(r.remTok)}`)}${r.resetTokAt ? hex(P.mute, ` · сброс через ${fmtDur(r.resetTokAt - Date.now())}`) : ""}`;
    }
    out(`  ${hex(P.mute, "⊙ tokens")} ${hex(P.v400, `↑${tilde}${fmtTok(t.prompt)}`)} ${hex(P.v400, `↓${tilde}${fmtTok(t.completion)}`)}${ctx}${lim}`);
  }

  private cmdTokens() {
    const win = this.ctxWindow;
    const cur = this.lastPrompt || this.estimatePrompt();
    const ratio = win ? cur / win : 0;
    const tilde = this.lastPromptReal ? "" : "~";
    out(`  ${gradient("Tokens", P.v400, P.f400, true)}`);
    out(`  ${hex(P.v500, "session".padEnd(9))} ${hex(P.v200, `↑ ${fmtTok(this.total.prompt)} in`)} ${hex(P.v700, "·")} ${hex(P.v200, `↓ ${fmtTok(this.total.completion)} out`)} ${hex(P.v700, "·")} ${hex(P.mute, `${this.total.calls} requests`)}`);
    if (win) {
      out(`  ${hex(P.v500, "context".padEnd(9))} ${this.bar(ratio)} ${hex(P.v200, `${tilde}${fmtTok(cur)} / ${fmtTok(win)}`)} ${hex(P.mute, `(${Math.round(ratio * 100)}%)`)}`);
      out(`  ${hex(P.mute, `warn ${Math.round(CTX_WARN * 100)}% · stop ${Math.round(CTX_BLOCK * 100)}% · /reset очищает контекст · MACE_CONTEXT меняет окно`)}`);
    } else {
      out(`  ${hex(P.mute, "demo-режим — токены не считаются")}`);
    }
  }

  private need(i: any, key: string): string {
    if (typeof i?.[key] !== "string" || !i[key]) throw new Error(`missing required argument "${key}"`);
    return i[key];
  }

  private shortCwd(max = 40): string {
    let p = this.cwd;
    const home = homedir();
    if (home && p.startsWith(home)) p = "~" + p.slice(home.length);
    return p.length > max ? "…" + p.slice(-(max - 1)) : p;
  }

  // ─── tools ───
  private tRead(path: string): string {
    const p = resolve(this.cwd, path);
    if (!existsSync(p)) return `Error: ${path} not found`;
    if (statSync(p).isDirectory()) return `Error: ${path} is a directory (use Glob)`;
    const t = readFileSync(p, "utf8");
    return `Read ${t.split("\n").length} lines from ${path}\n\n${t}`;
  }
  private tWrite(path: string, content: string): string {
    const p = resolve(this.cwd, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return `Wrote ${content.length} bytes to ${path}`;
  }
  private tEdit(path: string, oldS: string, newS: string): string {
    const p = resolve(this.cwd, path);
    if (!existsSync(p)) return `Error: ${path} not found`;
    if (!oldS) return `Error: old_string is empty`;
    const t = readFileSync(p, "utf8");
    const count = t.split(oldS).length - 1;
    if (count === 0) return `Error: old_string not found in ${path}`;
    if (count > 1) return `Error: old_string matches ${count} places in ${path} — add more context to make it unique`;
    const idx = t.indexOf(oldS);
    writeFileSync(p, t.slice(0, idx) + newS + t.slice(idx + oldS.length));
    return `Edited ${path}`;
  }
  private async tBash(cmd: string): Promise<string> {
    const r = await runShell(cmd, this.cwd, this.ctrl?.signal);
    if (r.aborted) return "Error: interrupted by user";
    if (r.timedOut) return `${r.text}\n[timed out]`.trim();
    if (r.code !== 0) return `${r.text}\n[exit code ${r.code}]`.trim();
    return r.text || "(no output)";
  }
  private tGlob(pattern: string): string {
    const matchers = expandBraces(pattern).map(p => ({ re: globToRe(p), base: !p.includes("/") }));
    const hits: string[] = [];
    const walk = (dir: string) => {
      let ents;
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (hits.length > 200) return;
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        const rel = relative(this.cwd, full).split(sep).join("/");
        if (matchers.some(m => m.re.test(m.base ? e.name : rel))) hits.push(rel);
      }
    };
    walk(this.cwd);
    return hits.join("\n") || "(no matches)";
  }
  private async tGrep(pattern: string, path: string): Promise<string> {
    const cmd = `grep -rnI --color=never --exclude-dir=node_modules --exclude-dir=.git -e ${shq(pattern)} ${shq(path)} | head -100`;
    const r = await runShell(cmd, this.cwd, this.ctrl?.signal);
    return r.text || "(no matches)";
  }

  // ─── banner ───
  private async banner(animate = true) {
    if (IS_TTY) stdout.write("\x1b[2J\x1b[3J\x1b[H");
    if (animate) await sleep(FAST_MODE ? 0 : 30);
    if (COLOR_MODE === "none" && IS_TTY) {
      out(`  ${hex(P.err, "⚠ Color disabled. Remove NO_COLOR / set FORCE_COLOR=3")}\n`);
    }
    out();
    await drawLogo(animate);
    out();
    out(`  ${hex(P.f400, "✻")}  ${gradient("terminal AI agent", P.v400, P.f400)} ${hex(P.v700, "·")} ${hex(P.v500, "v0.2")}`);
    out();

    const isDemo = this.providerKey === "demo";
    const row = (label: string, value: string, badge = "") =>
      `${hex(P.v500, label.padEnd(9))} ${bold(P.v200, value)}${badge ? "  " + badge : ""}`;
    const rows: string[] = [];
    rows.push(row("provider", isDemo ? "demo (no key)" : this.provider.name,
      isDemo ? "" : hex(P.f400, this.provider.free ? "● free" : "● paid")));
    rows.push(row("model", this.model));
    const fb = this.provider.fallbackModels?.length;
    if (fb && fb > 1) rows.push(row("fallback", `${fb} models`, hex(P.mute, "auto-switch on overload")));
    rows.push(row("cwd", this.shortCwd(48)));
    for (const l of box(rows)) out(l);
    out();

    if (isDemo) {
      out(`  ${hex(P.v500, "Добавь бесплатный ключ в .env:")} ${hex(P.f400, "GEMINI_API_KEY=...")}`);
      out(`  ${hex(P.mute, "ключ: https://aistudio.google.com/apikey")}`);
    } else {
      const freeKeys = Object.entries(PROVIDERS).filter(([, p]) => p.free).map(([k]) => k);
      out(`  ${hex(P.mute, "free:")} ${freeKeys.map(k => hex(P.v400, k)).join(hex(P.v700, " · "))}`);
    }
    out(`  ${hex(P.f400, "/help")} ${hex(P.mute, "commands")} ${hex(P.v700, "·")} ${hex(P.f400, "/provider")} ${hex(P.mute, "switch")} ${hex(P.v700, "·")} ${hex(P.f400, "/tokens")} ${hex(P.mute, "usage")} ${hex(P.v700, "·")} ${hex(P.f400, "Ctrl+C")} ${hex(P.mute, "interrupt")}`);
  }

  // ─── schemas ───
  private toolSchemasOpenAI(): any[] {
    const fn = (name: string, description: string, properties: Record<string, any>, required: string[]) =>
      ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
    const s = { type: "string" };
    return [
      fn("Read", "Read a text file and return its contents", { path: s }, ["path"]),
      fn("Write", "Create or overwrite a file with the given content", { path: s, content: s }, ["path", "content"]),
      fn("Edit", "Replace old_string with new_string in a file (old_string must be unique)", { path: s, old_string: s, new_string: s }, ["path", "old_string", "new_string"]),
      fn("Bash", "Run a non-interactive shell command and return its output", { command: s }, ["command"]),
      fn("Glob", "Find files by wildcard pattern, e.g. *.ts or src/**/*.{ts,tsx}", { pattern: s }, ["pattern"]),
      fn("Grep", "Search file contents for a pattern (path is optional, defaults to .)", { pattern: s, path: s }, ["pattern"]),
    ];
  }
  private toolSchemasAnthropic(): any[] {
    return this.toolSchemasOpenAI().map(t => ({
      name: t.function.name, description: t.function.description, input_schema: t.function.parameters,
    }));
  }

  private systemPrompt(): string {
    return [
      "You are MACEAGENT, a capable terminal coding agent running inside the user's shell.",
      `Working directory: ${this.cwd}`,
      `OS: ${platform()} · Today: ${new Date().toISOString().slice(0, 10)}`,
      "You can read, write and edit files and run shell commands through the provided tools.",
      "Explore with Glob/Grep/Read before changing things; use Edit for small changes and Write for new files; keep shell commands non-interactive.",
      "Be concise and answer in the user's language. Use Markdown sparingly (short lists, fenced code blocks with a language tag).",
      "After using tools, finish with a one or two sentence summary of what you did.",
    ].join("\n");
  }

  // ─── provider calls ───
  private async callAnthropic(model: string, spinner: Spinner, signal: AbortSignal): Promise<Completion> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey });

    const messages: any[] = [];
    for (const h of this.history) {
      if (h.role === "user") {
        messages.push({ role: "user", content: h.content });
      } else if (h.role === "assistant") {
        const blocks: any[] = [];
        if (h.content) blocks.push({ type: "text", text: h.content });
        for (const tc of h.toolCalls) {
          let input: any = {};
          try { input = JSON.parse(tc.arguments || "{}"); } catch {}
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
        messages.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "(empty)" }] });
      } else {
        const block = { type: "tool_result", tool_use_id: h.toolCallId, content: h.result };
        const last = messages[messages.length - 1];
        if (last && last.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") last.content.push(block);
        else messages.push({ role: "user", content: [block] });
      }
    }

    const md = new MdStream();
    let streaming = false;
    try {
      const stream = client.messages.stream(
        { model, max_tokens: 8192, system: this.systemPrompt(), messages, tools: this.toolSchemasAnthropic() },
        { signal },
      );
      stream.on("text", (t: string) => {
        if (!streaming) { spinner.stop(); streaming = true; }
        md.write(t);
      });
      const resp = await stream.finalMessage();
      const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const toolCalls: ToolCall[] = resp.content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input) }));
      const u: any = resp.usage ?? {};
      const usage: Usage = {
        prompt: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        completion: u.output_tokens ?? 0,
      };
      return { text, toolCalls, finish: resp.stop_reason ?? undefined, printed: md.printed, usage };
    } catch (e: any) {
      if (signal.aborted) throw new Interrupted();
      if (e instanceof ApiError || e instanceof Interrupted) throw e;
      const ra = parseFloat(e?.headers?.["retry-after"] ?? "");
      throw new ApiError(e?.status ?? 0, String(e?.message || e).slice(0, 300), {
        retryAfterMs: isNaN(ra) ? undefined : ra * 1000,
        kind: e?.status ? "http" : "network",
      });
    } finally {
      md.end();
    }
  }

  private async callOpenAI(model: string, spinner: Spinner, signal: AbortSignal): Promise<Completion> {
    const isGemini = this.providerKey === "gemini";
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };

    const messages: any[] = [{ role: "system", content: this.systemPrompt() }];
    for (const h of this.history) {
      if (h.role === "user") {
        messages.push({ role: "user", content: h.content });
      } else if (h.role === "tool") {
        const m: any = { role: "tool", tool_call_id: h.toolCallId, content: h.result || "(no output)" };
        if (isGemini) m.name = h.name;               // Gemini требует имя функции в ответе
        messages.push(m);
      } else {
        const m: any = { role: "assistant", content: h.content || null };
        if (h.toolCalls.length > 0) {
          m.tool_calls = h.toolCalls.map((tc, k) => {
            const o: any = { id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments || "{}" } };
            if (isGemini) {
              // Gemini 3: thought_signature нужно вернуть как есть, иначе 400.
              // Если вызов сделала другая модель (fallback) — подставляем «пропустить проверку».
              if (tc.extra && h.model === model) o.extra_content = tc.extra;
              else if (k === 0) o.extra_content = { google: { thought_signature: "skip_thought_signature_validator" } };
            }
            return o;
          });
        }
        messages.push(m);
      }
    }

    const body: any = {
      model, messages, stream: true,
      max_tokens: isGemini ? 8192 : 4096,
      tools: this.toolSchemasOpenAI(), tool_choice: "auto",
      stream_options: { include_usage: true },
    };
    if (isGemini && REASONING) body.reasoning_effort = REASONING;

    const resp = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(body) }, REQ_TIMEOUT_MS, signal);
    this.captureRate(resp.headers);
    if (!resp.ok) throw parseApiError(resp.status, resp.statusText, await resp.text(), resp.headers);
    const reader = resp.body?.getReader();
    if (!reader) throw new ApiError(0, "пустое тело ответа", { kind: "network" });

    const dec = new TextDecoder();
    const md = new MdStream();
    let buf = "";
    let text = "";
    let finish: string | undefined;
    let streaming = false;
    let usage: Usage | undefined;
    const calls: ToolCall[] = [];
    const byIndex = new Map<number, ToolCall>();

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let json: any;
      try { json = JSON.parse(data); } catch { return; }
      if (Array.isArray(json)) json = json[0];
      if (json?.error) {
        throw parseApiError(Number(json.error.code) || 500, String(json.error.status ?? ""), JSON.stringify(json));
      }
      if (json?.usage) {
        usage = {
          prompt: Number(json.usage.prompt_tokens) || 0,
          completion: (Number(json.usage.completion_tokens) || 0) + (Number(json.usage.completion_tokens_details?.reasoning_tokens) || 0),
        };
      }
      const choice = json?.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) return;

      if (typeof delta.content === "string" && delta.content) {
        if (!streaming) { spinner.stop(); streaming = true; }
        text += delta.content;
        md.write(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const name: string = tc.function?.name || "";
          let args = tc.function?.arguments;
          if (args && typeof args !== "string") args = JSON.stringify(args);
          const hasIdx = typeof tc.index === "number";
          let cur = hasIdx ? byIndex.get(tc.index) : calls[calls.length - 1];

          // Gemini присылает каждый вызов целиком (часто без index или с index=0 для всех) —
          // поэтому новое имя при уже завершённых аргументах = новый вызов.
          let isNew = !cur;
          if (cur && name && cur.name) {
            if (tc.id && tc.id !== cur.id) isNew = true;
            else if (!tc.id) { try { JSON.parse(cur.arguments); isNew = true; } catch { /* ещё идёт стрим */ } }
          }
          if (isNew) {
            cur = { id: tc.id || "", name: "", arguments: "" };
            calls.push(cur);
            if (hasIdx) byIndex.set(tc.index, cur);
          }
          cur = cur!;
          if (tc.id && !cur.id) cur.id = tc.id;
          if (name && !cur.name) cur.name = name;
          if (args) cur.arguments += args;
          if (tc.extra_content) cur.extra = tc.extra_content;
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) handleLine(line);
      }
      if (buf.trim()) handleLine(buf);
    } catch (e: any) {
      if (e instanceof ApiError || e instanceof Interrupted) throw e;
      if (signal.aborted) throw new Interrupted();
      throw new ApiError(0, `поток оборвался: ${e?.message || e}`, { kind: "network" });
    } finally {
      md.end();
    }

    const used = new Set<string>();
    const toolCalls = calls.filter(c => c.name).map(c => {
      let id = c.id;
      if (!id || used.has(id)) id = `call_${Math.random().toString(36).slice(2, 10)}`;
      used.add(id);
      return { ...c, id, arguments: c.arguments || "{}" };
    });
    return { text, toolCalls, finish, printed: md.printed, usage };
  }

  // ─── один запрос с retry + fallback по моделям ───
  private note(s: string) { out(`  ${hex(P.v500, s)}`); }

  /** Запоминает x-ratelimit-* заголовки ответа (Groq, Mistral, OpenRouter; Gemini их не отдаёт). */
  private captureRate(h: Headers) {
    const g = (n: string) => h.get(n);
    const num = (n: string) => { const v = g(n); return v !== null && v !== "" && !isNaN(Number(v)) ? Number(v) : undefined; };
    const now = Date.now();
    const at = (ms: number | undefined) => (ms === undefined ? undefined : now + ms);
    const info: RateInfo = {
      at: now,
      limitReq: num("x-ratelimit-limit-requests"), remReq: num("x-ratelimit-remaining-requests"), resetReqAt: at(parseDur(g("x-ratelimit-reset-requests"))),
      limitTok: num("x-ratelimit-limit-tokens"),   remTok: num("x-ratelimit-remaining-tokens"),   resetTokAt: at(parseDur(g("x-ratelimit-reset-tokens"))),
    };
    if (info.limitReq === undefined && num("x-ratelimit-limit") !== undefined) {      // стиль OpenRouter
      info.limitReq = num("x-ratelimit-limit"); info.remReq = num("x-ratelimit-remaining");
      const r = num("x-ratelimit-reset");
      if (r) info.resetReqAt = r > 1e12 ? r : r > 1e9 ? r * 1000 : now + r * 1000;
    }
    if (info.limitReq !== undefined || info.remReq !== undefined || info.limitTok !== undefined || info.remTok !== undefined) this.rate[this.providerKey] = info;
  }

  /** Через сколько мс вернётся квота после 429 (undefined — неизвестно). */
  private guessReset(err: ApiError): number | undefined {
    if (this.providerKey === "gemini" && err.daily) return msToPacificMidnight();
    if (err.retryAfterMs !== undefined) return err.retryAfterMs;
    if (err.daily) return msToUtcMidnight();
    return undefined;
  }

  /** GET /models — реально доступные этому ключу чат-модели (null — запрос не удался). */
  private async fetchModels(): Promise<string[] | null> {
    if (this.providerKey === "demo" || this.providerKey === "anthropic") return null;
    try {
      const resp = await fetchWithTimeout(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      }, Math.min(REQ_TIMEOUT_MS, 20000));
      if (!resp.ok) return null;
      const j: any = await resp.json();
      const raw: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
      const skip = /whisper|tts|speech|embed|guard|moderation|orpheus|playai|imagen|veo|image|audio|transcribe|rerank|safeguard/i;
      const ids = raw
        .filter(m => m?.active !== false)
        .map(m => String(m?.id ?? m?.name ?? "").replace(/^models\//, ""))
        .filter(id => id && !skip.test(id));
      // «умные» модели вперёд
      const score = (id: string) => (/gpt-oss|llama-3\.3|70b|120b|qwen|kimi|large|pro|3\.[5-9]/i.test(id) ? 0 : 1);
      ids.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
      this.liveModels[this.providerKey] = ids;
      return ids;
    } catch { return null; }
  }

  private async complete(models: string[], label: string, discovered = false): Promise<Completion | null> {
    const signal = this.ctrl!.signal;
    let lastErr: ApiError | null = null;
    const tried: string[] = [];

    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      tried.push(model);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) throw new Interrupted();
        const spinner = new Spinner();
        spinner.start(attempt ? "Retrying…" : label);
        try {
          const r = this.providerKey === "anthropic"
            ? await this.callAnthropic(model, spinner, signal)
            : await this.callOpenAI(model, spinner, signal);
          spinner.stop();
          if (mi > 0) this.note(`↳ ответила ${model}`);
          (r as any).model = model;
          return r;
        } catch (e: any) {
          spinner.stop();
          if (e instanceof Interrupted || signal.aborted) throw new Interrupted();
          const err: ApiError = e instanceof ApiError ? e : new ApiError(0, String(e?.message || e), { kind: "network" });
          lastErr = err;
          const st = err.status;

          const badKey = st === 401 || st === 403 || /api key not valid|api_key_invalid|invalid api key|incorrect api key/i.test(err.message);
          if (badKey) { this.printFailure(err, tried, true); return null; }

          if (st === 404) { this.note(`↳ ${model}: модель не найдена`); break; }

          if (st === 429) {
            const wait = err.retryAfterMs;
            if (attempt === 0 && wait !== undefined && wait <= 8000 && !err.daily) {
              this.note(`↻ 429 · лимит · ${model} · повтор через ${(wait / 1000 + 0.3).toFixed(1)}с`);
              await sleep(wait + 300);
              continue;
            }
            const reset = this.guessReset(err);
            if (reset !== undefined) this.blocked[`${this.providerKey}:${model}`] = { until: Date.now() + reset, why: clip(err.message, 70) };
            this.note(`↳ ${model}: квота исчерпана${reset !== undefined ? ` · восстановится через ${fmtDur(reset)} (≈ ${fmtWhen(reset)})` : ""}`);
            break;
          }

          const retryable = st >= 500 || err.kind !== "http";
          if (retryable && attempt === 0) {
            const delay = 600 + Math.random() * 400;
            this.note(`↻ ${err.kind === "http" ? st : err.kind} · ${model} · повтор через ${(delay / 1000).toFixed(1)}с`);
            await sleep(delay);
            continue;
          }
          this.note(`↳ ${model}: ${st || err.kind} ${clip(err.message, 80)}`);
          break;
        }
      }
      if (mi < models.length - 1) this.note(`↳ переключаюсь на ${models[mi + 1]}…`);
    }
    // все модели дали 404 → спрашиваем у провайдера, что реально доступно этому ключу
    if (!discovered && lastErr?.status === 404 && this.providerKey !== "anthropic") {
      const live = await this.fetchModels();
      const fresh = (live ?? []).filter(m => !tried.includes(m));
      if (fresh.length) {
        this.note(`↳ запрашиваю список моделей ключа… найдено ${fresh.length}, пробую лучшие`);
        const r = await this.complete(fresh.slice(0, 3), label, true);
        if (r) {
          this.model = (r as any).model;
          this.note(`✓ модель по умолчанию теперь ${this.model} (список: /models)`);
        }
        return r;
      }
      if (live && !fresh.length) this.note("↳ ключу не доступна ни одна чат-модель — проверь проект/лимиты в консоли провайдера");
    }
    this.printFailure(lastErr, tried, false);
    return null;
  }

  private printFailure(err: ApiError | null, tried: string[], fatalKey: boolean) {
    out(`  ${hex(P.err, "✗")} ${hex(P.err, `${this.provider.name}${err?.status ? ` ${err.status}` : ""}: ${clip(err?.message ?? "unknown error", cols() - 20)}`)}`);
    if (fatalKey) {
      out(`  ${hex(P.v500, `Проверь ${this.provider.keyEnv} в .env`)}${this.providerKey === "gemini" ? hex(P.mute, " · ключ: https://aistudio.google.com/apikey") : ""}`);
    } else {
      out(`  ${hex(P.mute, "пробовал:")} ${tried.map(m => hex(P.v400, m)).join(hex(P.v700, " · "))}`);
      if (err?.status === 429) {
        const left = tried.map(m => this.blocked[`${this.providerKey}:${m}`]).filter(Boolean).map(b => b!.until - Date.now()).filter(x => x > 0);
        if (left.length) {
          const soon = Math.min(...left);
          out(`  ${hex(P.v500, "Лимит восстановится через")} ${hex(P.f400, fmtDur(soon))} ${hex(P.mute, `(≈ ${fmtWhen(soon)}) · подробности: /limits`)}`);
        }
        out(`  ${hex(P.v500, "Лимит бесплатного тарифа — подожди или переключись:")} ${hex(P.f400, "/provider <name>")}`);
      }
      else if (err?.status === 404) out(`  ${hex(P.v500, "Модели ключа:")} ${hex(P.f400, "/models")} ${hex(P.mute, "· затем /model <имя>")}`);
      else out(`  ${hex(P.v500, "Диагностика:")} ${hex(P.f400, "/test")}`);
    }
  }

  // ─── unified turn ───
  private async turn(userMsg: string) {
    this.history.push({ role: "user", content: userMsg });
    if (this.providerKey === "demo") return this.demo(userMsg);

    const baseLen = this.history.length - 1;
    const models: string[] = [this.model];
    for (const m of this.provider.fallbackModels ?? []) if (!models.includes(m)) models.push(m);

    this.busy = true;
    this.ctrl = new AbortController();
    this.turnUsage = { prompt: 0, completion: 0, calls: 0, estimated: false };
    try {
      const MAX_ITER = 15;
      for (let iter = 0; iter < MAX_ITER; iter++) {
        if (!this.checkTokens()) {
          if (iter === 0) this.history.length = baseLen;
          return;
        }
        const result = await this.complete(models, iter === 0 ? "Thinking…" : "Continuing…");
        if (!result) {
          if (iter === 0) { this.history.length = baseLen; this.note("(сообщение не отправлено — попробуй ещё раз)"); }
          return;
        }
        if (result.printed) out();
        this.addUsage(result);

        if (!result.text && result.toolCalls.length === 0) {
          this.note(`(пустой ответ от модели${result.finish ? ` · finish_reason=${result.finish}` : ""})`);
          return;
        }
        if (result.finish === "length") this.note("⚠ ответ обрезан по max_tokens");

        this.history.push({
          role: "assistant",
          content: result.text || null,
          toolCalls: result.toolCalls,
          model: (result as any).model ?? this.model,
        });
        if (result.toolCalls.length === 0) return;

        for (const tc of result.toolCalls) {
          let args: any = {};
          let badJson = false;
          try { args = JSON.parse(tc.arguments || "{}"); } catch { badJson = true; }
          this.toolCall(tc.name, args);

          const t0 = Date.now();
          let res: string;
          const fn = this.tools[tc.name];
          if (this.ctrl.signal.aborted) res = "Error: interrupted by user";
          else if (badJson) res = "Error: tool arguments are not valid JSON";
          else if (!fn) res = `Error: unknown tool ${tc.name}`;
          else {
            const sp = new Spinner();
            sp.start(`Running ${tc.name}…`);
            try { res = await fn(args); } catch (e: any) { res = `Error: ${e?.message ?? e}`; }
            sp.stop();
          }
          this.toolRes(tc.name, args, res, Date.now() - t0);
          const forModel = res.length > MAX_TOOL_RESULT
            ? res.slice(0, MAX_TOOL_RESULT) + `\n…[truncated ${res.length - MAX_TOOL_RESULT} chars]`
            : res;
          this.history.push({ role: "tool", toolCallId: tc.id, name: tc.name, result: forModel });
        }
        if (this.ctrl.signal.aborted) throw new Interrupted();
        out();
      }
      out(`  ${hex(P.err, "✗ max iterations reached")}`);
    } catch (e: any) {
      if (e instanceof Interrupted) {
        out(`\n  ${hex(P.f400, "■")} ${hex(P.v400, "interrupted")}`);
        if (this.history.length === baseLen + 1) this.history.length = baseLen;
      } else {
        out(`  ${hex(P.err, `✗ ${e?.message ?? e}`)}`);
      }
    } finally {
      this.busy = false;
      this.ctrl = null;
      this.printTurnUsage();
    }
  }

  // ─── tool display ───
  private toolSummary(name: string, args: Record<string, any>): string {
    switch (name) {
      case "Read": case "Write": case "Edit": return String(args.path ?? "");
      case "Bash": return String(args.command ?? "").split("\n")[0];
      case "Glob": return String(args.pattern ?? "");
      case "Grep": return `${args.pattern ?? ""}${args.path ? ` in ${args.path}` : ""}`;
      default: return Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
    }
  }
  private toolCall(name: string, args: Record<string, any>) {
    const meta = TOOL_META[name] ?? { icon: "◆", color: P.v400 };
    const room = Math.max(10, cols() - name.length - 10);
    out(`  ${hex(meta.color, meta.icon)} ${bold(P.v100, name)}  ${hex(P.v400, clip(this.toolSummary(name, args), room))}`);
  }
  private toolRes(name: string, args: Record<string, any>, res: string, ms: number) {
    const plain = strip(res);
    const lines = plain.split("\n");
    const err = isErrorResult(plain);
    const dur = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
    const gutter = hex(P.v700, "  │ ");
    const W = cols() - 8;
    const mark = err ? hex(P.err, "✗") : hex(P.ok, "✓");

    if (name === "Edit" && !err && typeof args.old_string === "string") {
      const MAX = 5;
      const o = args.old_string.split("\n"), n = String(args.new_string ?? "").split("\n");
      for (const l of o.slice(0, MAX)) out(gutter + hex(P.err, clip("- " + l, W)));
      if (o.length > MAX) out(gutter + hex(P.mute, `  … +${o.length - MAX} lines`));
      for (const l of n.slice(0, MAX)) out(gutter + hex(P.ok, clip("+ " + l, W)));
      if (n.length > MAX) out(gutter + hex(P.mute, `  … +${n.length - MAX} lines`));
    } else if (name === "Bash" || name === "Glob" || name === "Grep") {
      const MAX = 8;
      for (const l of lines.slice(0, MAX)) out(gutter + hex(err ? P.err : P.v500, clip(l, W)));
      if (lines.length > MAX) out(gutter + hex(P.mute, `… +${lines.length - MAX} more lines`));
    }

    const summary = (name === "Bash" || name === "Glob" || name === "Grep")
      ? (name === "Bash" ? (err ? "failed" : "done") : `${plain === "(no matches)" ? 0 : lines.length} result${lines.length === 1 ? "" : "s"}`)
      : clip(lines[0] ?? "", W - 12);
    out(`${hex(P.v700, "  ╰─")} ${mark} ${hex(err ? P.err : P.v400, summary)} ${hex(P.mute, "· " + dur)}`);
  }

  // ─── commands ───
  private helpText(): string {
    const row = (c: string, d: string) => `  ${hex(P.f400, c.padEnd(11))} ${hex(P.v300, d)}`;
    return [
      "",
      `  ${gradient("Commands", P.v400, P.f400, true)}`,
      ...COMMANDS.map(c => row(c.name, c.desc)),
      "",
      `  ${hex(P.mute, "Tips:")} ${hex(P.f400, "MACE_FAST=1")} ${hex(P.mute, "без анимации ·")} ${hex(P.f400, "MACE_TIMEOUT=90000")} ${hex(P.mute, "таймаут ·")} ${hex(P.f400, "MACE_REASONING=low")} ${hex(P.mute, "быстрее думает (Gemini)")}`,
      `  ${hex(P.mute, "Введи")} ${hex(P.f400, "/")} ${hex(P.mute, "— появится подсказка по командам,")} ${hex(P.f400, "Tab")} ${hex(P.mute, "выбирает (Shift+Tab — назад)")}`,
      "",
    ].join("\n");
  }

  private async cmd(line: string): Promise<boolean> {
    const [k, ...rest] = line.split(/\s+/);
    const arg = rest.join(" ");
    switch (k.toLowerCase()) {
      case "/exit": case "/quit": case "/q":
        out(`\n  ${gradient("✦ Bye", P.v400, P.f400)}\n`);
        return false;
      case "/help": out(this.helpText()); break;
      case "/clear": await this.banner(false); break;
      case "/reset": this.history = []; this.lastPrompt = 0; this.warnedCtx = false; out(`  ${hex(P.v400, "✓ history reset")}`); break;
      case "/test": await this.cmdTest(); break;
      case "/tokens": case "/usage": this.cmdTokens(); break;
      case "/provider": {
        if (arg) {
          const key = arg.toLowerCase();
          if (!PROVIDERS[key]) {
            out(`  ${hex(P.err, `unknown provider: ${arg}`)}`);
            out(`  ${hex(P.v500, "use:")} ${Object.keys(PROVIDERS).map(n => hex(P.f400, n)).join(hex(P.v700, ", "))}`);
            break;
          }
          if (!process.env[PROVIDERS[key].keyEnv]) {
            out(`  ${hex(P.err, `missing key: ${PROVIDERS[key].keyEnv}`)}`);
            break;
          }
          this.providerKey = key;
          this.provider = PROVIDERS[key];
          this.model = this.provider.defaultModel;
          this.history = []; this.lastPrompt = 0; this.warnedCtx = false;
          out(`  ${hex(P.v400, `✓ switched to ${this.provider.name} · ${this.model}`)}`);
          break;
        }
        out(`  ${gradient("Providers", P.v400, P.f400, true)}`);
        for (const [key, p] of Object.entries(PROVIDERS)) {
          const hasKey = !!process.env[p.keyEnv];
          const mark = key === this.providerKey ? hex(P.f400, "●") : hex(P.v700, "○");
          const badge = p.free ? hex(P.f400, "free") : hex(P.v500, "paid");
          const keyStatus = hasKey ? hex(P.ok, "key ✓") : hex(P.mute, `no key (${p.keyEnv})`);
          out(`  ${mark} ${hex(P.v300, key.padEnd(11))} ${badge}  ${hex(P.v500, p.defaultModel.padEnd(26))} ${keyStatus}`);
        }
        out(`  ${hex(P.mute, "use:")} ${hex(P.f400, "/provider <name>")}`);
        break;
      }
      case "/limits": case "/quota": await this.cmdLimits(); break;
      case "/models": {
        if (this.providerKey === "demo" || this.providerKey === "anthropic") { out(`  ${hex(P.v500, "/models работает для OpenAI-совместимых провайдеров")}`); break; }
        const sp = new Spinner(); sp.start("запрашиваю модели…");
        const ids = await this.fetchModels();
        sp.stop();
        if (!ids) { out(`  ${hex(P.err, "✗ не удалось получить список")} ${hex(P.mute, `(${this.baseUrl}/models) · проверь ключ: /test`)}`); break; }
        if (!ids.length) { out(`  ${hex(P.err, "✗ ключу не доступно ни одной чат-модели")} ${hex(P.mute, "— проверь проект / лимиты / регион в консоли провайдера")}`); break; }
        out(`  ${gradient(`${this.provider.name} · доступно ${ids.length}`, P.v400, P.f400, true)}`);
        for (const id of ids) out(`  ${id === this.model ? hex(P.f400, "●") : hex(P.v700, "○")} ${hex(id === this.model ? P.f400 : P.v300, id)}`);
        out(`  ${hex(P.mute, "выбрать:")} ${hex(P.f400, "/model <имя>")} ${hex(P.mute, "(Tab подставит из этого списка)")}`);
        break;
      }
      case "/model": {
        if (arg) this.model = arg;
        out(`  ${hex(P.v400, "model")} ${hex(P.v700, "=")} ${bold(P.v100, this.model)}`);
        const all = this.provider.fallbackModels ?? [];
        if (all.length) {
          out(`  ${hex(P.mute, "known:")} ${all.map(m => hex(m === this.model ? P.f400 : P.v400, m)).join(hex(P.v700, " · "))}`);
          if (arg && !all.includes(arg)) out(`  ${hex(P.v500, `⚠ ${arg} нет в списке известных — проверь через /test`)}`);
        }
        break;
      }
      case "/cwd":
        if (arg) {
          const p = resolve(this.cwd, arg);
          if (existsSync(p) && statSync(p).isDirectory()) this.cwd = p;
          else { out(`  ${hex(P.err, `not a directory: ${arg}`)}`); break; }
        }
        out(`  ${hex(P.v400, "cwd")} ${hex(P.v700, "=")} ${hex(P.v200, this.cwd)}`);
        break;
      case "/tools":
        for (const t of Object.keys(this.tools)) {
          const m = TOOL_META[t] ?? { icon: "•", color: P.f400 };
          out(`  ${hex(m.color, m.icon)} ${hex(P.v300, t)}`);
        }
        break;
      case "/colors":
        out(`  ${hex(P.v400, "color mode:")} ${hex(P.f400, COLOR_MODE)}`);
        out(`  ${hex(P.v700, "COLORTERM =")} ${hex(P.v400, JSON.stringify(COLORTERM))}`);
        out(`  ${hex(P.v700, "NO_COLOR  =")} ${hex(P.v400, String(NO_COLOR))}`);
        out(`  ${hex(P.v700, "FORCE     =")} ${hex(P.v400, String(FORCE ?? "unset"))}`);
        out(`  ${hex(P.v700, "MACE_FAST =")} ${hex(P.v400, String(FAST_MODE))}`);
        out(`  ${hex(P.v700, "TIMEOUT   =")} ${hex(P.v400, `${REQ_TIMEOUT_MS}ms`)}`);
        out();
        out(`  ${hex(P.v900, "██ v900")} ${hex(P.v800, "██ v800")} ${hex(P.v700, "██ v700")} ${hex(P.v600, "██ v600")} ${hex(P.v500, "██ v500")}`);
        out(`  ${hex(P.v400, "██ v400")} ${hex(P.v300, "██ v300")} ${hex(P.v200, "██ v200")} ${hex(P.f400, "██ f400")} ${hex(P.f500, "██ f500")}`);
        out(`  ${gradient("████████████████████████████████", P.v800, P.f400)}`);
        break;
      default:
        out(`  ${hex(P.err, `unknown command: ${k}`)} ${hex(P.mute, "· /help")}`);
    }
    return true;
  }

  /** /limits — остатки и время восстановления лимитов (делает пробный запрос на 1 токен). */
  private async cmdLimits() {
    if (this.providerKey === "demo") { out(`  ${hex(P.err, "no API key")} ${hex(P.mute, "— добавь ключ в .env")}`); return; }
    if (this.providerKey === "anthropic") { out(`  ${hex(P.v500, "/limits работает для OpenAI-совместимых провайдеров")}`); return; }

    const sp = new Spinner(); sp.start("проверяю лимиты…");
    let probe = "";
    try {
      const resp = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      }, Math.min(REQ_TIMEOUT_MS, 20000));
      this.captureRate(resp.headers);
      const body = await resp.text();
      if (!resp.ok) {
        const e = parseApiError(resp.status, resp.statusText, body, resp.headers);
        if (e.status === 429) {
          const r = this.guessReset(e);
          if (r !== undefined) this.blocked[`${this.providerKey}:${this.model}`] = { until: Date.now() + r, why: clip(e.message, 70) };
        }
        probe = `${e.status} ${clip(e.message, cols() - 24)}`;
      }
    } catch (e: any) { probe = clip(String(e?.message || e), cols() - 24); }
    sp.stop();

    const now = Date.now();
    out(`  ${gradient(`Limits · ${this.provider.name}`, P.v400, P.f400, true)} ${hex(P.mute, `· ${this.model}`)}`);
    const r = this.rate[this.providerKey];
    const row = (label: string, rem?: number, lim?: number, at?: number) => {
      if (rem === undefined && lim === undefined) return;
      const used = lim && rem !== undefined ? 1 - rem / lim : 0;
      const nums = lim ? `${fmtTok(rem ?? 0)} / ${fmtTok(lim)}` : fmtTok(rem ?? 0);
      const reset = at !== undefined ? `${hex(P.mute, "сброс через")} ${hex(P.f400, fmtDur(at - now))} ${hex(P.mute, `(≈ ${fmtWhen(at - now)})`)}` : "";
      out(`  ${hex(P.v500, label.padEnd(9))} ${lim ? this.bar(used, 16) + " " : ""}${hex(P.v200, nums)}  ${reset}`);
    };
    row("requests", r?.remReq, r?.limitReq, r?.resetReqAt);
    row("tokens", r?.remTok, r?.limitTok, r?.resetTokAt);
    if (!r) out(`  ${hex(P.mute, "этот провайдер не отдаёт остатки в заголовках ответа")}`);
    if (probe) out(`  ${hex(P.err, "✗")} ${hex(P.err, probe)}`);

    const active = Object.entries(this.blocked).filter(([, b]) => b.until > now);
    for (const k of Object.keys(this.blocked)) if (this.blocked[k].until <= now) delete this.blocked[k];
    if (active.length) {
      out();
      out(`  ${hex(P.err, "Исчерпано")}`);
      for (const [k, b] of active) {
        const [pk, ...mm] = k.split(":");
        out(`  ${hex(P.err, "✗")} ${hex(P.v300, `${pk} · ${mm.join(":")}`)} ${hex(P.mute, "— вернётся через")} ${hex(P.f400, fmtDur(b.until - now))} ${hex(P.mute, `(≈ ${fmtWhen(b.until - now)})`)}`);
      }
    } else if (!probe) {
      out(`  ${hex(P.ok, "✓")} ${hex(P.mute, "лимиты не исчерпаны")}`);
    }

    if (this.providerKey === "gemini") {
      const m = msToPacificMidnight();
      out(`  ${hex(P.mute, "ориентир: дневная квота Gemini сбрасывается в 00:00 по Тихому океану — через")} ${hex(P.f400, fmtDur(m))} ${hex(P.mute, `(≈ ${fmtWhen(m)})`)}`);
    } else if (this.providerKey === "openrouter") {
      const m = msToUtcMidnight();
      out(`  ${hex(P.mute, "ориентир: дневной лимит free-моделей обычно сбрасывается в 00:00 UTC — через")} ${hex(P.f400, fmtDur(m))} ${hex(P.mute, `(≈ ${fmtWhen(m)})`)}`);
    }
  }

  /** /test — проверяет ключ и каждую модель маленьким запросом. */
  private async cmdTest() {
    if (this.providerKey === "demo") { out(`  ${hex(P.err, "no API key")} ${hex(P.mute, "— добавь GEMINI_API_KEY в .env")}`); return; }
    if (this.providerKey === "anthropic") { out(`  ${hex(P.v500, "/test работает для OpenAI-совместимых провайдеров")}`); return; }
    const models = [this.model, ...(this.provider.fallbackModels ?? []).filter(m => m !== this.model)];
    out(`  ${gradient(`Testing ${this.provider.name}`, P.v400, P.f400, true)} ${hex(P.mute, `· key …${this.apiKey.slice(-4)}`)}`);
    let notFound = 0;
    for (const m of models) {
      const t0 = Date.now();
      const sp = new Spinner();
      sp.start(`${m}…`);
      try {
        const resp = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: m, messages: [{ role: "user", content: "Reply with the single word: OK" }], max_tokens: 256 }),
        }, REQ_TIMEOUT_MS);
        const ms = Date.now() - t0;
        if (!resp.ok) {
          const e = parseApiError(resp.status, resp.statusText, await resp.text(), resp.headers);
          sp.stop();
          if (e.status === 404) notFound++;
          out(`  ${hex(P.err, "✗")} ${hex(P.v300, m.padEnd(24))} ${hex(P.err, `${e.status} ${clip(e.message, cols() - 40)}`)}`);
        } else {
          const j: any = await resp.json();
          sp.stop();
          const txt = String(j?.choices?.[0]?.message?.content ?? "").trim();
          out(`  ${hex(P.ok, "✓")} ${hex(P.v300, m.padEnd(24))} ${hex(P.mute, `${ms}ms`)} ${hex(P.v500, txt ? `"${clip(txt, 20)}"` : "(empty reply)")}`);
        }
      } catch (e: any) {
        sp.stop();
        out(`  ${hex(P.err, "✗")} ${hex(P.v300, m.padEnd(24))} ${hex(P.err, clip(String(e?.message || e), cols() - 40))}`);
      }
    }
    if (notFound === models.length) {
      out(`  ${hex(P.v500, "Ключ рабочий, но этих моделей у него нет. Смотри реальный список:")} ${hex(P.f400, "/models")}`);
    }
  }

  // ─── demo ───
  private async demo(msg: string) {
    const low = msg.toLowerCase().trim();
    const exec1 = async (name: string, args: Record<string, any>, run: () => string | Promise<string>) => {
      this.toolCall(name, args);
      const t0 = Date.now();
      let res: string;
      try { res = await run(); } catch (e: any) { res = `Error: ${e?.message ?? e}`; }
      this.toolRes(name, args, res, Date.now() - t0);
    };
    if (low === "list" || low === "ls") return exec1("Glob", { pattern: "*" }, () => this.tGlob("*"));
    if (low.startsWith("read ")) { const p = msg.slice(5).trim(); return exec1("Read", { path: p }, () => this.tRead(p)); }
    if (low.startsWith("run ")) { const c = msg.slice(4); return exec1("Bash", { command: c }, () => this.tBash(c)); }
    out(`  ${gradient("MACEAGENT · demo mode", P.v400, P.f400, true)}`);
    out(`  ${hex(P.v200, `Принял: ${msg}`)}`);
    out(`  ${hex(P.v700, "Создай .env рядом с файлом:")} ${hex(P.f400, "GEMINI_API_KEY=AIzaSy...")}`);
  }

  private promptHeader(): string {
    const model = this.providerKey === "demo" ? "demo" : this.model;
    const dot = hex(P.v700, "·");
    const win = this.ctxWindow;
    const pct = win && this.lastPrompt ? Math.round((this.lastPrompt / win) * 100) : 0;
    const ctx = pct >= 1 ? ` ${dot} ${hex(pct >= CTX_WARN * 100 ? P.f500 : P.mute, `ctx ${pct}%`)}` : "";
    return `${gradient("╭─", P.v700, P.v500)} ${hex(P.f400, "◆")} ${bold(P.v300, "mace")} ${dot} ${hex(P.v400, this.provider.name)} ${dot} ${hex(P.v500, model)}${ctx} ${dot} ${hex(P.mute, this.shortCwd(36))}`;
  }

  // ─── подсказки после «/» ───
  /** Встроенное дополнение readline отключено — Tab обрабатывается в handleTab() (выбор из списка подсказки). */
  private static completeCmd(line: string): [string[], string] {
    return [[], line];
  }

  // выбор по Tab: base — строка, от которой строится список; applied — то, что сейчас вставлено в строку ввода
  private cycle: { base: string; items: string[]; i: number; applied: string } | null = null;

  private argOptions(cmd: string): string[] {
    if (cmd === "/provider") return Object.keys(PROVIDERS);
    if (cmd === "/model") return this.liveModels[this.providerKey]?.length ? this.liveModels[this.providerKey] : (this.provider.fallbackModels ?? []);
    return [];
  }

  /** Полные варианты строки, которые можно выбрать Tab-ом для данного ввода. */
  private candidates(line: string): string[] {
    if (!line.startsWith("/")) return [];
    const sp = line.indexOf(" ");
    if (sp === -1) {
      const q = line.toLowerCase();
      return COMMANDS.map(c => c.name).filter(n => n.startsWith(q));
    }
    const name = line.slice(0, sp).toLowerCase();
    const arg = line.slice(sp + 1).trim().toLowerCase();
    return this.argOptions(name).filter(o => o.toLowerCase().startsWith(arg)).map(o => `${name} ${o}`);
  }

  /** Tab / Shift+Tab: вставить следующий (предыдущий) вариант в строку ввода. */
  private handleTab(back: boolean) {
    const rl = this.rl as any;
    const line: string = rl.line ?? "";
    let cy = this.cycle;
    if (!cy || cy.applied !== line) {
      const items = this.candidates(line);
      if (!items.length) { this.cycle = null; return; }
      cy = this.cycle = { base: line, items, i: back ? items.length : -1, applied: line };
    }
    cy.i = (cy.i + (back ? -1 : 1) + cy.items.length) % cy.items.length;
    let text = cy.items[cy.i];
    // единственный вариант-команда с аргументом: ставим пробел, чтобы следующий Tab выбирал аргумент
    if (cy.items.length === 1) {
      const def = COMMANDS.find(c => c.name === text);
      if (def?.usage || text.startsWith("/") && !text.includes(" ") && this.argOptions(text).length) text += " ";
    }
    cy.applied = text;
    rl.write(null, { ctrl: true, name: "e" });
    rl.write(null, { ctrl: true, name: "u" });
    rl.write(text);
    if (cy.items.length === 1) this.cycle = null;       // дальше — новый список (аргументы)
  }

  private hintFor(typed: string): string[] {
    // во время выбора Tab-ом список строится от исходного ввода, а выбранный пункт подсвечивается
    const line = this.cycle?.base ?? typed;
    const sel = this.cycle ? this.cycle.items[this.cycle.i] : null;
    if (!line.startsWith("/")) return [];
    const W = cols() - 6;
    const sp = line.indexOf(" ");
    const tabHelp = "Tab — выбрать · Shift+Tab — назад · Enter — выполнить";

    // 1) ещё вводим имя команды → список подходящих
    if (sp === -1) {
      const q = line.toLowerCase();
      const m = COMMANDS.filter(c => c.name.startsWith(q));
      if (!m.length) return [`  ${hex(P.err, "✗")} ${hex(P.mute, `нет команды ${clip(line, 20)} · /help`)}`];
      const rows = m.map(c => {
        const pad = " ".repeat(Math.max(1, 11 - c.name.length));
        const desc = hex(P.mute, clip(c.desc, Math.max(10, W - 18)));
        if (c.name === sel) return `  ${hex(P.f400, "▸")} ${bold(P.f400, c.name)}${pad}${hex(P.v300, clip(c.desc, Math.max(10, W - 18)))}`;
        const done = c.name.slice(0, q.length), rest = c.name.slice(q.length);
        return `  ${hex(P.v700, "│")} ${bold(P.f400, done)}${hex(P.v300, rest)}${pad}${desc}`;
      });
      rows.push(`  ${hex(P.v700, "╰")} ${hex(P.mute, tabHelp)}`);
      return rows;
    }

    // 2) команда введена → показываем usage и варианты аргумента (выбираются Tab-ом)
    const name = line.slice(0, sp).toLowerCase();
    const arg = line.slice(sp + 1).trim().toLowerCase();
    const def = COMMANDS.find(c => c.name === name);
    if (!def) return [];
    const rows = [`  ${hex(P.v700, "│")} ${bold(P.f400, def.usage ?? def.name)} ${hex(P.mute, "— " + def.desc)}`];
    const opts = this.argOptions(name).filter(o => o.toLowerCase().startsWith(arg));
    if (opts.length) {
      const selArg = sel && sel.startsWith(name + " ") ? sel.slice(name.length + 1) : null;
      let used = 16;
      const shown: string[] = [];
      for (const o of opts) {
        if (used + o.length + 3 > W) break;
        used += o.length + 3;
        const hasKey = name !== "/provider" || !!process.env[PROVIDERS[o]?.keyEnv ?? ""];
        if (o === selArg) shown.push(bold(P.f400, `▸ ${o}`));
        else if (o === this.model || o === this.providerKey) shown.push(hex(P.f400, o));
        else shown.push(hex(hasKey ? P.v400 : P.mute, o));
      }
      if (shown.length) rows.push(`  ${hex(P.v700, "│")} ${hex(P.mute, "варианты:")} ${shown.join(hex(P.v700, " · "))}`);
      if (name === "/provider") rows.push(`  ${hex(P.v700, "│")} ${hex(P.mute, "серые — нет ключа в .env")}`);
      rows.push(`  ${hex(P.v700, "╰")} ${hex(P.mute, tabHelp)}`);
    }
    rows[rows.length - 1] = rows[rows.length - 1].replace("│", "╰");
    return rows;
  }

  /** Рисует подсказку под строкой ввода, не сдвигая курсор. */
  private renderHint() {
    if (!IS_TTY || !stdin.isTTY || !this.prompting) return;
    const line: string = (this.rl as any).line ?? "";
    const rows = this.hintFor(line);
    if (!rows.length && !this.hintRows) return;
    const pos = (this.rl as any).getCursorPos?.() ?? { cols: 0 };
    let s = "\n\x1b[J";                                   // ниже строки ввода: очистить старую подсказку
    if (rows.length) s += rows.join("\n");
    s += `\x1b[${rows.length ? rows.length : 1}A`;         // вернуться на строку ввода
    s += `\x1b[${pos.cols + 1}G`;                          // и в позицию курсора
    stdout.write(s);
    this.hintRows = rows.length;
  }

  private clearHintOnSubmit() {
    if (this.hintRows) { stdout.write("\x1b[J"); this.hintRows = 0; }
  }

  async run() {
    await this.banner();

    if (IS_TTY && stdin.isTTY) {
      stdin.on("keypress", (_s: string, key: any) => {
        if (!this.prompting) return;
        if (key?.name === "return" || key?.name === "enter") { this.cycle = null; this.clearHintOnSubmit(); return; }
        if (key?.name === "tab") {
          this.handleTab(!!key.shift);
          setImmediate(() => this.renderHint());
          return;
        }
        this.cycle = null;                               // любая другая клавиша завершает выбор по Tab
        setImmediate(() => this.renderHint());           // после того как readline обновил строку
      });
    }

    this.rl.on("SIGINT", () => {
      if (this.busy) { this.ctrl?.abort(); return; }
      if ((this.rl as any).line) { (this.rl as any).write(null, { ctrl: true, name: "u" }); return; }
      out(`\n  ${gradient("✦ Bye", P.v400, P.f400)}\n`);
      process.exit(0);
    });

    while (true) {
      out();
      out(this.promptHeader());
      let line: string;
      try {
        this.prompting = true; this.hintRows = 0; this.cycle = null;
        line = (await this.rl.question(`${hex(P.v600, "╰─")}${hex(P.f400, "❯")} `)).trim();
      } catch { break; }
      finally { this.prompting = false; }
      if (!line) continue;
      if (line.startsWith("/")) { if (!(await this.cmd(line))) break; continue; }
      out();
      await this.turn(line);
    }
    this.rl.close();
  }
}

new MaceAgent().run();