# Oracle Deployment — fantasy.cda1234567.com

## Prerequisites

- Oracle VM at 168.138.203.245 already runs stock dashboard (port 3400) via Docker + Caddy
- GitHub repo `cda1234567/fantasy-nba` must exist and have been pushed to `main` (CI builds `ghcr.io/cda1234567/fantasy-nba:latest`)
  - Create at https://github.com/new — name it `fantasy-nba`, set to public or private
- Cloudflare DNS: wildcard `*.cda1234567.com` → Oracle IP already configured (same as stock)

---

## Steps

### 1. SSH to Oracle

```bash
ssh ubuntu@168.138.203.245
```

### 2. Create app directory and data volume

```bash
mkdir -p ~/fantasy/data
cd ~/fantasy
```

### 3. Create the env file

```bash
cat > .env.server <<'EOF'
APP_PORT=3410
LEAGUE_ID=default
ANTHROPIC_API_KEY=your_key_here
EOF
```

> Fill in `ANTHROPIC_API_KEY` if you want Claude-powered AI GM decisions. Leave blank for heuristic-only mode.

### 4. Download the compose file

Option A — copy from your local machine:
```bash
scp "D:/claude/fantasy nba/docker-compose.server.yml" ubuntu@168.138.203.245:~/fantasy/
```

Option B — paste inline on the server:
```bash
cat > ~/fantasy/docker-compose.server.yml <<'EOF'
services:
  fantasy:
    image: ghcr.io/cda1234567/fantasy-nba:latest
    container_name: fantasy-nba
    ports:
      - "3410:3410"
    volumes:
      - ~/fantasy/data:/app/data
    env_file:
      - .env.server
    restart: unless-stopped
EOF
```

### 5. Pull image and start container

```bash
cd ~/fantasy
docker compose -f docker-compose.server.yml pull
docker compose -f docker-compose.server.yml up -d
```

### 6. Verify the container is healthy

```bash
curl http://127.0.0.1:3410/api/state
# Should return JSON with draft state
```

### 7. Add Caddy subdomain block

Edit the Caddy config (typically `/etc/caddy/Caddyfile`):

```bash
sudo nano /etc/caddy/Caddyfile
```

Append the contents of `deploy/Caddyfile.fragment` (see below). You need to set two env vars for basic auth — generate the password hash with:

```bash
caddy hash-password --plaintext 'your_password_here'
```

Then export before reloading:
```bash
export APP_BASIC_AUTH_USER=admin
export APP_BASIC_AUTH_PASSWORD_HASH='$2a$14$...'   # output from caddy hash-password
```

Or add them to your systemd service's environment file at `/etc/systemd/system/caddy.service.d/override.conf`:
```ini
[Service]
Environment="APP_BASIC_AUTH_USER=admin"
Environment="APP_BASIC_AUTH_PASSWORD_HASH=$2a$14$..."
```

Then reload:
```bash
sudo systemctl daemon-reload
sudo systemctl reload caddy
```

**Caddyfile block to append:**
```
fantasy.cda1234567.com {
    encode gzip zstd
    basicauth {
        {$APP_BASIC_AUTH_USER} {$APP_BASIC_AUTH_PASSWORD_HASH}
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        X-Frame-Options SAMEORIGIN
        Referrer-Policy strict-origin-when-cross-origin
    }
    reverse_proxy localhost:3410
}
```

### 8. Verify from public internet

```bash
curl -u admin:your_password https://fantasy.cda1234567.com/api/state
```

Should return JSON. Open https://fantasy.cda1234567.com in your browser and enter credentials when prompted.

### 9. Cloudflare DNS (if not already covered by wildcard)

If `*.cda1234567.com` wildcard is not set, add:
- Type: `A`
- Name: `fantasy`
- Content: `168.138.203.245`
- Proxy: enabled (orange cloud)

---

## Manual deploy on push

Pushes to `main` trigger GitHub Actions to build + push `ghcr.io/cda1234567/fantasy-nba:latest`.
After CI is green, deploy on the Oracle VM with:

```bash
# One-shot manual deploy
ssh -i ~/.ssh/oracle_vm.key ubuntu@168.138.203.245 "cd ~/fantasy && docker compose -f docker-compose.server.yml pull && docker compose -f docker-compose.server.yml up -d"

# Or use the helper script (pushes, waits for CI, deploys, verifies /api/health)
./deploy/push.ps1
```

> **Note:** Watchtower still runs on the VM for the stock dashboard. The fantasy-nba compose
> file no longer carries `com.centurylinklabs.watchtower.enable`, so Watchtower ignores it.
> Do not `docker stop watchtower` — that would break auto-updates for the stock dashboard too.

---

## Troubleshooting

```bash
# Container logs
docker logs fantasy-nba -f

# Restart manually
cd ~/fantasy && docker compose -f docker-compose.server.yml up -d --force-recreate

# Check port
ss -tlnp | grep 3410

# Caddy status
sudo systemctl status caddy
sudo journalctl -u caddy -n 50
```
