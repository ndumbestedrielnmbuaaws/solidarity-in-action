# Solidarity in Action — Full-Stack Live Teaching Platform

Real-time classroom with WebRTC video/audio, live whiteboard, chat, recording, and invite links.

---

## Architecture

```
Browser A (Teacher)          Browser B (Student)
     │                              │
     │──── WebSocket ───────────────│
     │         │                    │
     │      Node.js + Socket.io     │
     │      (Signalling Server)     │
     │         │                    │
     │◄── WebRTC P2P ──────────────►│
         (Direct video/audio)
```

| Layer | Technology |
|---|---|
| Signalling | Node.js + Socket.io (WebSocket) |
| Video / Audio | WebRTC `RTCPeerConnection` (`getUserMedia`) |
| STUN | Google STUN (free) |
| TURN | Your own Coturn (for restricted networks) |
| Whiteboard sync | Socket.io events (stroke-by-stroke) |
| Chat | Socket.io broadcast |

---

## Quick Start (local)

```bash
# 1. Install dependencies
npm install

# 2. Copy env
cp .env.example .env
# Edit .env — set APP_URL=http://localhost:3000

# 3. Run
npm start
# → http://localhost:3000

# Development (auto-restart)
npm run dev
```

Open two browser tabs — one as Teacher, one as Student. Both will ask for camera/mic permission.

---

## AWS Deployment (EC2 — recommended for you as AWS Cloud Engineer)

### Option A — EC2 + Nginx + PM2 (simplest)

```bash
# 1. Launch EC2 (Ubuntu 22.04 LTS, t3.small or larger)
#    Security group: open 80, 443, 3000

# 2. SSH in and install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx

# 3. Clone / upload your project
git clone https://github.com/YOUR_REPO/solidarity-in-action.git
cd solidarity-in-action
npm install --production

# 4. Set env
cp .env.example .env
nano .env
#  PORT=3000
#  APP_URL=https://your-domain.com
#  NODE_ENV=production

# 5. Run with PM2
npm install -g pm2
pm2 start server/index.js --name sia
pm2 save && pm2 startup

# 6. Nginx reverse proxy
sudo nano /etc/nginx/sites-available/sia
```

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";   # WebSocket
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/sia /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 7. SSL (required for getUserMedia in browsers)
sudo certbot --nginx -d your-domain.com
```

---

### Option B — Elastic Beanstalk

```bash
# Install EB CLI
pip install awsebcli

# Init
eb init -p node.js-20 solidarity-in-action

# Add Procfile
echo "web: npm start" > Procfile

# Deploy
eb create sia-production
eb setenv PORT=8080 APP_URL=https://your-eb-url.elasticbeanstalk.com NODE_ENV=production
eb deploy
```

---

### Option C — ECS (Fargate) with Application Load Balancer

See `docker/Dockerfile` (create below) for container packaging.

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node","server/index.js"]
```

---

## TURN Server (for users behind strict firewalls / corporate NAT)

Without TURN, WebRTC direct connections fail for ~15% of users.

```bash
# Install Coturn on a separate EC2 (t3.micro is fine)
sudo apt-get install -y coturn

sudo nano /etc/turnserver.conf
```

```
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
realm=turn.your-domain.com
server-name=turn.your-domain.com
user=sia:your-strong-password
cert=/etc/letsencrypt/live/turn.your-domain.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.your-domain.com/privkey.pem
```

Then in `.env`:
```
TURN_URL=turn:turn.your-domain.com:3478
TURN_USERNAME=sia
TURN_CREDENTIAL=your-strong-password
```

---

## Scaling (beyond 150 users per room)

For multiple rooms at scale, replace the in-memory `rooms` Map with Redis:

```bash
npm install ioredis @socket.io/redis-adapter
```

Then in `server/index.js`:
```js
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const pub = createClient({ url: process.env.REDIS_URL });
const sub = pub.duplicate();
await Promise.all([pub.connect(), sub.connect()]);
io.adapter(createAdapter(pub, sub));
```

Use ElastiCache (Redis) on AWS for managed Redis.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default 3000) |
| `NODE_ENV` | No | `production` enables security headers |
| `APP_URL` | Yes (prod) | Your domain, used for invite link URLs |
| `STUN_URL` | No | STUN server URL (default: Google STUN) |
| `TURN_URL` | Recommended | TURN server for NAT traversal |
| `TURN_USERNAME` | If TURN | TURN username |
| `TURN_CREDENTIAL` | If TURN | TURN password |

---

## Socket.io Events Reference

### Client → Server

| Event | Payload | Who |
|---|---|---|
| `join-room` | `{roomCode, name, role, token?}` | Anyone |
| `rtc-offer` | `{to, offer}` | Anyone |
| `rtc-answer` | `{to, answer}` | Anyone |
| `rtc-ice` | `{to, candidate}` | Anyone |
| `wb-stroke` | stroke object | Teacher |
| `wb-text` | text block object | Teacher |
| `wb-clear` | — | Teacher |
| `wb-undo` | — | Teacher |
| `chat-msg` | `{text}` | Anyone |
| `state-update` | `{micOn?, camOn?, handRaised?}` | Anyone |
| `teacher-mute-all` | — | Teacher |
| `teacher-lower-hands` | — | Teacher |
| `teacher-kick` | `{targetSocketId}` | Teacher |
| `poll-launch` | `{question, options}` | Teacher |
| `poll-vote` | `{option}` | Student |
| `poll-close` | — | Teacher |
| `generate-link` | `{label, expiryMs, maxUses}` | Teacher |
| `revoke-link` | `{token}` | Teacher |

### Server → Client

| Event | Payload |
|---|---|
| `joined` | `{participant, participants[], whiteboard[], chat[]}` |
| `join-error` | `{reason}` |
| `participant-joined` | `{participant}` |
| `participant-left` | `{socketId}` |
| `participant-state` | `{socketId, micOn, camOn, handRaised}` |
| `rtc-offer/answer/ice` | forwarded as-is |
| `wb-stroke/text/clear/undo` | forwarded as-is |
| `chat-msg` | message object |
| `mute-all` / `lower-all-hands` | — |
| `kicked` | `{reason}` |
| `poll-launched` / `poll-tally` / `poll-closed` | poll data |
| `link-generated` / `link-revoked` | link data |

---

## Browser Support

| Browser | Camera/Mic | WebRTC | Notes |
|---|---|---|---|
| Chrome 90+ | ✅ | ✅ | Best |
| Firefox 88+ | ✅ | ✅ | Good |
| Safari 14+ | ✅ | ✅ | Requires HTTPS |
| Edge 90+ | ✅ | ✅ | Chromium-based |

> **HTTPS is required** for `getUserMedia` in all browsers except `localhost`.
> Always run behind Nginx + Let's Encrypt in production.
