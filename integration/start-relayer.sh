#!/bin/bash

echo "🚀 Starting Sui ↔ EVM Cross-Chain Relayer"
echo "=========================================="

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ .env file not found!"
    echo "Please create a .env file with your configuration:"
    echo ""
    echo "PACKAGE_ID=0xab3af58ae717aed8d071e1d84d2ec55f56ec466fbe60e687f3561fe13e1b8ff0"
    echo "FACTORY_ID=0x93e6ddbfafa2f98c0441ac93840046730e963e832d0c61b338c530c482e46365"
    echo "FACTORY_VERSION=516497581"
    echo "EVM_FACTORY_ADDRESS=0x6e7F7f50Ce82F1A49e9F9292B1EF1538E5B52d1A"
    echo ""
    exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Start the relayer
echo "🔌 Starting WebSocket relayer on ws://localhost:8080"
echo "📡 Bridge service will be available for cross-chain orders"
echo ""
echo "💡 In another terminal, run: npm run client"
echo "💡 Or connect your own WebSocket client to ws://localhost:8080"
echo ""

npm run relayer 