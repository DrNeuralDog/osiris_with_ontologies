@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "PROJECT=C:\Users\Psina\Desktop\AlexWork\AppProjects\OsirisWithOntologies"
set "DOCKER_DESKTOP=C:\Program Files\Docker\Docker\Docker Desktop.exe"
set "URL=http://localhost:3000"

title OSIRIS Launcher

echo ==========================================
echo          OSIRIS WITH ONTOLOGIES
echo ==========================================
echo.

echo [1/5] Checking project folder...
if not exist "%PROJECT%\docker-compose.yml" (
    echo [ERROR] docker-compose.yml was not found in:
    echo %PROJECT%
    echo.
    pause
    exit /b 1
)

cd /d "%PROJECT%"
echo Project: %CD%

echo.
echo [2/5] Checking Docker Engine...
docker info >nul 2>&1

if errorlevel 1 (
    echo Docker Engine is not ready.

    if exist "%DOCKER_DESKTOP%" (
        echo Starting Docker Desktop...
        start "" "%DOCKER_DESKTOP%"
    ) else (
        echo [ERROR] Docker Desktop executable was not found:
        echo %DOCKER_DESKTOP%
        echo.
        pause
        exit /b 1
    )

    echo Waiting for Docker Engine...
    set /a tries=0

    :wait_docker
    timeout /t 2 /nobreak >nul
    docker info >nul 2>&1
    if not errorlevel 1 goto docker_ready

    set /a tries+=1
    if !tries! GEQ 60 (
        echo [ERROR] Docker Engine did not become ready after waiting.
        echo.
        pause
        exit /b 1
    )
    goto wait_docker
)

:docker_ready
echo Docker Engine is ready.

echo.
echo [3/5] Starting OSIRIS containers...
docker compose up -d

if errorlevel 1 (
    echo.
    echo [ERROR] Docker Compose failed to start OSIRIS.
    echo.
    echo Current compose status:
    docker compose ps
    echo.
    echo Last logs:
    docker compose logs --tail=80
    echo.
    pause
    exit /b 1
)

echo.
docker compose ps

echo.
echo [4/5] Waiting for OSIRIS on %URL% ...
set /a webtries=0

:wait_web
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } } catch {}; exit 1" >nul 2>&1

if not errorlevel 1 goto web_ready

set /a webtries+=1
if !webtries! GEQ 60 (
    echo.
    echo [WARNING] Containers are running, but OSIRIS has not answered on port 3000 yet.
    echo Opening the browser anyway.
    echo If the page does not load, inspect:
    echo     docker compose logs -f osiris
    goto open_browser
)

timeout /t 2 /nobreak >nul
goto wait_web

:web_ready
echo OSIRIS is responding.

:open_browser
echo.
echo [5/5] Opening browser...
start "" "%URL%"

echo.
echo ==========================================
echo OSIRIS launch command completed.
echo ==========================================
echo.
timeout /t 3 /nobreak >nul

endlocal
exit /b 0
