@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title MACEAGENT uninstaller
echo.
echo  ================================================
echo   MACEAGENT uninstaller (Windows)
echo  ================================================
echo.

set "INSTALL_DIR=%LOCALAPPDATA%\maceagent"
set "BIN_DIR=%LOCALAPPDATA%\maceagent\bin"

if not exist "%INSTALL_DIR%" (
  echo  [!] %INSTALL_DIR% не найден — видимо не установлен
  echo.
  pause & exit /b 0
)

choice /C YN /M "Удалить %INSTALL_DIR% и launcher"
if errorlevel 2 (
  echo  [=] отменено
  pause & exit /b 0
)

if exist "%INSTALL_DIR%\.env" (
  echo  [!] в .env может быть твой API-ключ
  choice /C YN /M "Сохранить .env в %USERPROFILE%\maceagent.env.backup"
  if errorlevel 1 (
    copy /Y "%INSTALL_DIR%\.env" "%USERPROFILE%\maceagent.env.backup" >nul
    echo  [+] сохранён: %USERPROFILE%\maceagent.env.backup
  )
)

rmdir /S /Q "%INSTALL_DIR%"
if errorlevel 1 (
  echo  [X] не удалось удалить %INSTALL_DIR%
  pause & exit /b 1
)
echo  [+] удалён %INSTALL_DIR%

:: убираем из PATH
powershell -NoProfile -Command ^
  "$p=[Environment]::GetEnvironmentVariable('Path','User');" ^
  "if($p -like '*%BIN_DIR%*'){" ^
  "  $new=($p -split ';' | Where-Object {$_ -ne '%BIN_DIR%'}) -join ';';" ^
  "  [Environment]::SetEnvironmentVariable('Path',$new,'User');" ^
  "  Write-Host '  [+] убрал из PATH (нужен новый терминал)'" ^
  "} else { Write-Host '  [=] в PATH не было' }"

echo.
echo  Готово. MACEAGENT удалён.
echo.
pause
endlocal