@echo off
REM Обёртка CLI для Windows: в собранном приложении Node берётся из Electron (ORCA_NODE), иначе — системный node.
REM Без блоков ( ... ): внутри них %ERRORLEVEL% подставляется при разборе, а не после запуска.
REM Сообщение об ошибке латиницей: консоль cmd в OEM-кодировке, UTF-8 кириллица выведется кракозябрами.
setlocal
if not defined ORCA_NODE goto system_node
set ELECTRON_RUN_AS_NODE=1
"%ORCA_NODE%" "%~dp0orca-board.js" %*
exit /b %ERRORLEVEL%

:system_node
where node >nul 2>&1
if errorlevel 1 goto no_node
node "%~dp0orca-board.js" %*
exit /b %ERRORLEVEL%

:no_node
echo orca-board: node not found and ORCA_NODE is not set 1>&2
exit /b 2
