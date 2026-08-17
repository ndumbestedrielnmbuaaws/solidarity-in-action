#!/bin/bash
sudo apt update -y
sudo apt install -y git nginx

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Clone your app
sudo git clone https://github.com/ndumbestedrielnmbuaaws/solidarity-in-action.git /var/www/solidarity-in-action
cd /var/www/solidarity-in-action

# Install dependencies
npm ci --production

# Install PM2
sudo npm install -g pm2
pm2 start server/index.js --name sia
pm2 save
pm2 startup

# Enable firewall
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 3000
