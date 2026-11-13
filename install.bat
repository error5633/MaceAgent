@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title MACEAGENT installer

echo.
echo  ================================================
echo   MACEAGENT installer (Windows)
echo  ================================================
echo.

:: ── 1. где мы ──────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
set "AGENT_SRC=%SCRIPT_DIR%maceagent.ts"

if not exist "%AGENT_SRC%" (
  echo  [X] maceagent.ts не найден рядом с install.bat
  echo      ожидал: %AGENT_SRC%
  echo.
  pause
  exit /b 1
)

:: ── 2. ищем рантайм ─────────────────────────────────
set "RUNTIME="
where bun >nul 2>&1
if %errorlevel%==0 (
  for /f "delims=" %%v in ('bun --version') do set "BUN_VER=%%v"
  set "RUNTIME=bun"
  echo  [+] нашёл bun !BUN_VER!
) else (
  where node >nul 2>&1
  if !errorlevel!==0 (
    for /f "delims=" %%v in ('node --version') do set "NODE_VER=%%v"
    set "RUNTIME=node"
    echo  [+] нашёл node !NODE_VER!
  )
)

if not defined RUNTIME (
  echo.
  echo  [X] Ни bun, ни node не найдены в PATH.
  echo.
  echo      Поставь один из них и запусти install.bat снова:
  echo        bun  — https://bun.sh
  echo        node — https://nodejs.org  ^(18+^)
  echo.
  pause
  exit /b 1
)

:: ── 3. папки ───────────────────────────────────────
set "INSTALL_DIR=%LOCALAPPDATA%\maceagent"
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if not exist "%INSTALL_DIR%\node_modules" if "%RUNTIME%"=="node" (
  echo  [*] устанавливаю tsx...
  pushd "%INSTALL_DIR%"
  if not exist package.json call npm init -y >nul 2>&1
  call npm install --silent --no-fund --no-audit tsx
  if errorlevel 1 (
    echo  [X] npm install tsx упал — проверь сеть/npm
    popd
    pause
    exit /b 1
  )
  popd
  echo  [+] tsx установлен
)

copy /Y "%AGENT_SRC%" "%INSTALL_DIR%\maceagent.ts" >nul
if errorlevel 1 (
  echo  [X] не могу скопировать maceagent.ts
  pause
  exit /b 1
)
echo  [+] maceagent.ts -^> %INSTALL_DIR%\

:: ── 4. .env ────────────────────────────────────────
set "ENV_FILE=%INSTALL_DIR%\.env"
set "ENV_CREATED=0"
if not exist "%ENV_FILE%" (
  >"%ENV_FILE%" (
    echo # MACEAGENT .env — впиши ключ хотя бы одного провайдера
    echo.
    echo # Gemini — рекомендую: https://aistudio.google.com/apikey
    echo GEMINI_API_KEY=
    echo.
    echo # GROQ_API_KEY=
    echo # OPENROUTER_API_KEY=
    echo # MISTRAL_API_KEY=
    echo # ANTHROPIC_API_KEY=
    echo.
    echo # MACE_PROVIDER=gemini
    echo # MACE_MODEL=gemini-2.5-flash
    echo # MACE_FAST=1
  )
  set "ENV_CREATED=1"
  echo  [+] создал .env -^> %ENV_FILE%
) else (
  echo  [=] .env уже есть - не трогаю
)

:: ── 5. launcher в PATH (через отдельную папку) ─────
set "BIN_DIR=%LOCALAPPDATA%\maceagent\bin"
if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"

if "%RUNTIME%"=="bun" (
  >"%BIN_DIR%\maceagent.cmd" (
    echo @echo off
    echo bun "%INSTALL_DIR%\maceagent.ts" %%*
  )
) else (
  >"%BIN_DIR%\maceagent.cmd" (
    echo @echo off
    echo "%INSTALL_DIR%\node_modules\.bin\tsx.cmd" "%INSTALL_DIR%\maceagent.ts" %%*
  )
)
echo  [+] launcher -^> %BIN_DIR%\maceagent.cmd

:: добавляем BIN_DIR в пользовательский PATH если ещё нет
powershell -NoProfile -Command ^
  "$p=[Environment]::GetEnvironmentVariable('Path','User');" ^
  "if($p -notlike '*%BIN_DIR%*'){[Environment]::SetEnvironmentVariable('Path',$p+';%BIN_DIR%','User'); Write-Host '  [+] добавил в PATH (нужен новый терминал)'} else { Write-Host '  [=] PATH уже содержит папку' }"

:: ── 6. предупреждение про grep ─────────────────────
echo.
echo  ================================================
echo   ВАЖНО для Windows:
echo   инструмент Grep использует `grep`, которого нет
echo   в нативном Windows. Read/Write/Edit/Bash работают,
echo   а Grep вернёт ошибку.
echo.
echo   Если нужен полноценный агент — используй WSL:
echo     wsl --install
echo   и запусти там ./install.sh
echo  ================================================
echo.

:: ── 7. итог ────────────────────────────────────────
echo  Готово!
echo.
if "%ENV_CREATED%"=="1" (
  echo  1. Открой .env и впиши ключ:
  echo     %ENV_FILE%
  echo     ключ Gemini: https://aistudio.google.com/apikey
  echo.
  start "" notepad "%ENV_FILE%"
)
echo  2. Открой НОВЫЙ терминал (чтобы PATH подхватился) и запусти:
echo     maceagent
echo.
echo  3. Внутри сессии:  /test   /models   /limits   /help
echo.
pause
endlocal