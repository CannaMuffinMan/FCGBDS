@echo off
REM FCGBDS Deployment Script for Windows
REM This script helps deploy FCGBDS in Windows environments

echo FCGBDS Customer System Deployment
echo ==================================

REM Check for .env file
if not exist ".env" (
    echo [WARN] .env file not found. Copying from .env.example...
    copy .env.example .env
    echo [EDIT] Please edit .env with your bot defense settings.
)

echo [OK] Open source edition — no license key required.

REM Check for Docker
docker --version >nul 2>&1
if %errorlevel% equ 0 (
    docker-compose --version >nul 2>&1
    if %errorlevel% equ 0 (
        echo [OK] Docker and Docker Compose detected
        set DEPLOY_METHOD=docker
    )
)

if defined DEPLOY_METHOD (
    echo [DOCKER] Deploying with Docker Compose...

    REM Build and start services
    docker-compose build
    if errorlevel 1 (
        echo [ERROR] Docker build failed
        pause
        exit /b 1
    )

    docker-compose up -d
    if errorlevel 1 (
        echo [ERROR] Docker deployment failed
        pause
        exit /b 1
    )

    echo [OK] FCGBDS deployed successfully!
    echo.
    echo Dashboard: http://localhost:3002
    echo API: http://localhost:3001
    echo Health: http://localhost:3001/health
    echo.
    echo To view logs: docker-compose logs -f
    echo To stop: docker-compose down

) else (
    echo [NODE] Deploying with Node.js...

    REM Check Node.js
    node --version >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Node.js not found. Please install Node.js 18+
        pause
        exit /b 1
    )

    for /f "tokens=2 delims=v." %%i in ('node --version') do set NODE_MAJOR=%%i
    if %NODE_MAJOR% lss 18 (
        echo [ERROR] Node.js 18+ required. Current version:
        node --version
        pause
        exit /b 1
    )

    REM Install dependencies
    if not exist "node_modules" (
        echo Installing dependencies...
        npm install
        if errorlevel 1 (
            echo [ERROR] npm install failed
            pause
            exit /b 1
        )
    )

    REM Build the project
    echo Building project...
    npm run build
    if errorlevel 1 (
        echo [ERROR] Build failed
        pause
        exit /b 1
    )

    REM Start the service
    echo Starting FCGBDS...
    start /b npm start

    echo [OK] FCGBDS deployed successfully!
    echo.
    echo Dashboard: Run 'npm run dashboard' in another terminal
    echo API: http://localhost:3001
    echo Health: http://localhost:3001/health
)

echo.
echo [SUCCESS] Deployment complete!
echo Don't forget to configure your reverse proxy or API gateway to route requests through FCGBDS.

pause