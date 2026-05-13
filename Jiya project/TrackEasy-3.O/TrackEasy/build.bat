@echo off
REM ====================================================================
REM TrackEasy / Jiya  Docker Compose helper
REM ====================================================================
REM Usage examples:
REM   build.bat help            Show this help
REM
REM   build.bat build-web       Rebuild the trackeasy (web) image
REM   build.bat build-fraud     Rebuild the fraud-service image
REM   build.bat build-ml        Rebuild the ml-service image
REM   build.bat build-all       Rebuild every image
REM
REM   build.bat up              Start all services
REM   build.bat up-build        Rebuild and start all
REM   build.bat up-web          Rebuild + (re)start trackeasy only
REM   build.bat up-fraud        Rebuild + (re)start fraud-service only
REM   build.bat up-ml           Rebuild + (re)start ml-service only
REM
REM   build.bat down            Stop and remove containers (keep volumes)
REM   build.bat reset           Stop AND delete the mongo volume
REM
REM   build.bat restart         Restart all (no rebuild)
REM   build.bat restart-web     Restart trackeasy
REM   build.bat restart-fraud   Restart fraud-service
REM   build.bat restart-ml      Restart ml-service
REM
REM   build.bat logs            Tail all logs
REM   build.bat logs-web        Tail trackeasy logs
REM   build.bat logs-fraud      Tail fraud-service logs
REM   build.bat logs-ml         Tail ml-service logs
REM
REM   build.bat ps              Container status
REM   build.bat seed            Run server/scripts/seed.js inside trackeasy
REM ====================================================================

setlocal
REM Always run compose from this directory so docker-compose.yml is found
REM without needing the -f flag (avoids quoting headaches on paths with spaces).
cd /d "%~dp0"

if "%~1"=="" goto :help
if /I "%~1"=="help" goto :help
if /I "%~1"=="-h" goto :help
if /I "%~1"=="--help" goto :help

if /I "%~1"=="build-web"      ( docker compose build trackeasy        & goto :end )
if /I "%~1"=="build-fraud"    ( docker compose build fraud-service    & goto :end )
if /I "%~1"=="build-ml"       ( docker compose build ml-service       & goto :end )
if /I "%~1"=="build-all"      ( docker compose build                  & goto :end )

if /I "%~1"=="up"             ( docker compose up -d                  & goto :end )
if /I "%~1"=="up-build"       ( docker compose up -d --build          & goto :end )
if /I "%~1"=="up-web"         ( docker compose up -d --build trackeasy        & goto :end )
if /I "%~1"=="up-fraud"       ( docker compose up -d --build fraud-service    & goto :end )
if /I "%~1"=="up-ml"          ( docker compose up -d --build ml-service       & goto :end )

if /I "%~1"=="down"           ( docker compose down                   & goto :end )
if /I "%~1"=="reset"          ( docker compose down -v                & goto :end )

if /I "%~1"=="restart"        ( docker compose restart                & goto :end )
if /I "%~1"=="restart-web"    ( docker compose restart trackeasy      & goto :end )
if /I "%~1"=="restart-fraud"  ( docker compose restart fraud-service  & goto :end )
if /I "%~1"=="restart-ml"     ( docker compose restart ml-service     & goto :end )

if /I "%~1"=="logs"           ( docker compose logs -f --tail=100                  & goto :end )
if /I "%~1"=="logs-web"       ( docker compose logs -f --tail=100 trackeasy        & goto :end )
if /I "%~1"=="logs-fraud"     ( docker compose logs -f --tail=100 fraud-service    & goto :end )
if /I "%~1"=="logs-ml"        ( docker compose logs -f --tail=100 ml-service       & goto :end )

if /I "%~1"=="ps"             ( docker compose ps                                  & goto :end )
if /I "%~1"=="seed"           ( docker compose exec trackeasy node scripts/seed.js & goto :end )

echo Unknown command: %~1
echo.

:help
echo ============================================================
echo  TrackEasy / Jiya  Docker Compose helper
echo ============================================================
echo.
echo  Build:
echo    build.bat build-web        Rebuild trackeasy
echo    build.bat build-fraud      Rebuild fraud-service
echo    build.bat build-ml         Rebuild ml-service
echo    build.bat build-all        Rebuild everything
echo.
echo  Start / stop:
echo    build.bat up               Start all services
echo    build.bat up-build         Rebuild + start all
echo    build.bat up-web           Rebuild + (re)start trackeasy
echo    build.bat up-fraud         Rebuild + (re)start fraud-service
echo    build.bat up-ml            Rebuild + (re)start ml-service
echo    build.bat down             Stop everything (keep DB)
echo    build.bat reset            Stop everything and wipe DB volume
echo.
echo  Restart (no rebuild):
echo    build.bat restart          Restart all
echo    build.bat restart-web      Restart trackeasy
echo    build.bat restart-fraud    Restart fraud-service
echo    build.bat restart-ml       Restart ml-service
echo.
echo  Logs / status:
echo    build.bat logs             Tail all services
echo    build.bat logs-web         Tail trackeasy
echo    build.bat logs-fraud       Tail fraud-service
echo    build.bat logs-ml          Tail ml-service
echo    build.bat ps               Show container status
echo    build.bat seed             Seed demo data in MongoDB
echo ============================================================

:end
endlocal
