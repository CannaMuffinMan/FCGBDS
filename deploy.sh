#!/bin/bash

# FCGBDS Deployment Script
# This script helps deploy FCGBDS in various environments

set -e

echo "FCGBDS Customer System Deployment"
echo "=================================="

# Check if Docker is available
if command -v docker &> /dev/null && command -v docker-compose &> /dev/null; then
    echo "✓ Docker and Docker Compose detected"
    DEPLOY_METHOD="docker"
else
    echo "✓ Using Node.js deployment"
    DEPLOY_METHOD="node"
fi

# Check for .env file
if [ ! -f ".env" ]; then
    echo "⚠️  .env file not found. Copying from .env.example..."
    cp .env.example .env
    echo "✏️  Edit .env with your bot defense settings."
fi

echo "✓ Open source edition — no license key required."

if [ "$DEPLOY_METHOD" = "docker" ]; then
    echo "🐳 Deploying with Docker Compose..."

    # Build and start services
    docker-compose build
    docker-compose up -d

    echo "✓ FCGBDS deployed successfully!"
    echo ""
    echo "Dashboard: http://localhost:3002"
    echo "API: http://localhost:3001"
    echo "Health: http://localhost:3001/health"
    echo ""
    echo "To view logs: docker-compose logs -f"
    echo "To stop: docker-compose down"

elif [ "$DEPLOY_METHOD" = "node" ]; then
    echo "📦 Deploying with Node.js..."

    # Check Node.js version
    if ! command -v node &> /dev/null; then
        echo "❌ Node.js not found. Please install Node.js 18+"
        exit 1
    fi

    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo "❌ Node.js 18+ required. Current version: $(node -v)"
        exit 1
    fi

    # Install dependencies
    if [ ! -d "node_modules" ]; then
        echo "Installing dependencies..."
        npm install
    fi

    # Build the project
    echo "Building project..."
    npm run build

    # Start the service
    echo "Starting FCGBDS..."
    npm start &

    echo "✓ FCGBDS deployed successfully!"
    echo ""
    echo "Dashboard: http://localhost:3002 (run 'npm run dashboard' in another terminal)"
    echo "API: http://localhost:3001"
    echo "Health: http://localhost:3001/health"
    echo ""
    echo "Process ID: $!"
fi

echo ""
echo "🎉 Deployment complete!"
echo "Don't forget to configure your reverse proxy or API gateway to route requests through FCGBDS."