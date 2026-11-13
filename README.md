<div align="center">

# ◆ MACEAGENT

**Терминальный ИИ-агент для кода · один файл · любая модель · без зависимостей**

[![License: MIT](https://img.shields.io/badge/License-MIT-a78bfa.svg)](./LICENSE)

[Возможности](#возможности) · [Быстрый старт](#быстрый-старт) · [Удаление](#удаление) · [Настройка](#настройка) · [Команды](#команды) · [Проблемы](#проблемы)

</div>

---

MACEAGENT — один `.ts`-файл, который читает и правит файлы, запускает команды и стримит ответ. Ты описываешь задачу — он сам решает, какие инструменты использовать, и возвращает Markdown.

Работает с **пятью провайдерами**: Google Gemini, Groq, OpenRouter, Mistral, Anthropic. При 429 или перегрузке автоматически переключается на резервную модель и показывает, когда восстановится квота.

```
◆ mace · Google Gemini · gemini-2.5-flash · ~/projects/myapp

❯ прочитай package.json и найди устаревшие зависимости

  ◉ Read  package.json
  ╰─ ✓ Read 42 lines from package.json · 2ms
```

---

## Возможности

- **Один файл** — `maceagent.ts`, без сборки и бандлера
- **Bun или Node 18+** — работает на обоих
- **Потоковый Markdown** — bold, italic, код, блоки с подсветкой
- **Авто-fallback** по моделям и провайдерам
- **Учёт квот** — парсит `x-ratelimit-*` и `retry-after`
- **Слежение за контекстом** — предупреждение на 75%, отказ на 95%
- **Tab-подсказки** — `/` показывает команды, Tab выбирает
- **Ctrl+C** — прерывает запрос, история сохраняется
- **Demo-режим** — без ключа работают `ls`, `read`, `run`

---

## Быстрый старт

### Windows

```powershell
git clone https://github.com/ТВОЙ_НИК/maceagent.git
cd maceagent
.\install.bat
```

Установщик скопирует агент в `%LOCALAPPDATA%\maceagent\`, создаст `.env`, откроет в Блокноте, добавит `maceagent` в PATH.

Впиши ключ в `.env`, сохрани, **открой новый терминал**, запусти `maceagent`.

### Linux / macOS

```bash
git clone https://github.com/ТВОЙ_НИК/maceagent.git
cd maceagent
chmod +x install.sh
./install.sh
```

Отредактируй `~/.local/share/maceagent/.env`, запусти `maceagent`.

### Вручную

```bash
mkdir -p ~/.local/share/maceagent
cp maceagent.ts ~/.local/share/maceagent/
cd ~/.local/share/maceagent
echo "GEMINI_API_KEY=AIzaSy..." > .env
bun maceagent.ts
```

---

## Удаление

### Linux / macOS

```bash
bash uninstall.sh
```

### Windows

```powershell
.\uninstall.bat
```

Удаляет `maceagent.ts`, launcher и папку с `.env`. Перед удалением предложит сохранить ключи в `~/maceagent.env.backup` (или `%USERPROFILE%\maceagent.env.backup`).

Ручное удаление:

```bash
rm -rf ~/.local/share/maceagent ~/.local/bin/maceagent
# и убери строку "# MACEAGENT PATH" из ~/.bashrc / ~/.zshrc / ~/.profile
```

```powershell
rmdir /S /Q "%LOCALAPPDATA%\maceagent"
# и убери %LOCALAPPDATA%\maceagent\bin из PATH в переменных среды
```

---

## API-ключи

Нужен **один любой**. Бесплатные:

| Провайдер | Где взять | Контекст |
|---|---|---|
| **Google Gemini** ⭐ | https://aistudio.google.com/apikey | 1M |
| **Groq** | https://console.groq.com/keys | 128k |
| **OpenRouter** | https://openrouter.ai/keys | 128k |
| **Mistral** | https://console.mistral.ai/api-keys | 128k |
| **Anthropic** | https://console.anthropic.com | 200k, платно |

---

## Настройка

`.env` читается из двух мест (первое найденное побеждает):

1. `./.env` — текущая папка
2. `~/.local/share/maceagent/.env` — глобальный

```env
GEMINI_API_KEY=AIzaSy...

MACE_PROVIDER=gemini
MACE_MODEL=gemini-2.5-flash
MACE_FAST=1
MACE_TIMEOUT=60000
MACE_REASONING=low
MACE_CONTEXT=1000000
MACE_DEBUG=1
```

**Кодировка:** UTF-8 (BOM допустим) или UTF-16LE. Не `.env.txt`.

---

## Команды

| Команда | Что делает |
|---|---|
| `/help` | список команд |
| `/reset` | сбросить историю |
| `/provider <name>` | сменить провайдера |
| `/model <name>` | сменить модель |
| `/models` | живой список моделей |
| `/limits` | остатки квот |
| `/tokens` | расход + контекст |
| `/test` | проверить модели |
| `/cwd [path]` | сменить папку |
| `/colors` | режим цвета |
| `/exit` | выйти |

**Tab** — подсказки после `/`. **Ctrl+C** — прервать.

---

## Инструменты

| Инструмент | Назначение |
|---|---|
| **Read** | прочитать файл |
| **Write** | создать / перезаписать |
| **Edit** | заменить `old_string` → `new_string` |
| **Bash** | запустить команду |
| **Glob** | найти по маске |
| **Grep** | поиск по содержимому |

Результат обрезается до 30 000 символов. Bash — таймаут 120с.

**Windows:** `Grep` требует `grep`, которого нет нативно. Read/Write/Edit/Bash/Glob работают. Для полного — WSL.

---

## Примеры

**Рефакторинг:**
```
❯ в src/utils.ts функция parseDate на moment.js —
  перепиши на нативный Date, сигнатуру сохрани
```

**Разбор теста:**
```
❯ run npm test 2>&1 | tail -40
```

**Поиск проблем:**
```
❯ найди все места, где мы вызываем fetch() без таймаута
```

---

## Проблемы

### Пишет `demo (no key)`, хотя `.env` создан

```bash
MACE_DEBUG=1 maceagent
```

Покажет, какие файлы искались и какие ключи нашлись. Если пусто:

**1. Файл `.env.txt`?** `dir /a "%LOCALAPPDATA%\maceagent\.env*"` → если да: `ren .env.txt .env`.

**2. Не в правильном месте?** Читается только `./.env` и `~/.local/share/maceagent/.env`.

**3. Ключ вписан?** `GEMINI_API_KEY=` (пусто) = нет ключа.

**4. Кодировка?** UTF-16 без BOM не читается. Пересохрани как UTF-8.

### 429 quota exceeded

`/limits` покажет когда. Или `/provider groq`.

### Context overflow

`/reset` или `MACE_CONTEXT=2000000`.

### Anthropic не работает

```bash
cd ~/.local/share/maceagent
npm install @anthropic-ai/sdk
```

### Grep на Windows

Используй WSL: `wsl --install`.

### Нет анимации

`MACE_FAST=1` в `.env`.

---

## Лицензия

[MIT](./LICENSE).
