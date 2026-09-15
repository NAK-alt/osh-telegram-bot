#!/usr/bin/env bash
set -e

echo "=== Updating system packages ==="
sudo apt-get update -y && sudo apt-get upgrade -y

echo "=== Installing curl and git ==="
sudo apt-get install -y curl git build-essential

echo "=== Installing Node.js 20 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "Node.js version: $(node -v)"
echo "NPM version: $(npm -v)"

echo "=== Installing PM2 globally ==="
sudo npm install -g pm2

echo "=== Server setup complete! ==="
