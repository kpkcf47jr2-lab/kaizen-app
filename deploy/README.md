# Kaizen — Production Deployment

The backend is a single Node process (~100 MB steady) that serves the HTTP
API on `KAIZEN_PORT` and runs the AutoTickScheduler in-process. Deploy
targets, from easiest to most polished:

| Target | Cost | Setup | Fit |
|---|---|---|---|
| Any Ubuntu 22.04+ VPS | ~€4-6/mo (Hetzner CX22 / DO / OCI Free) | 10 min | ✅ Recommended for prod |
| Lightning Studio | credit-metered | 5 min | ⚠️ Dev only — studio sleeps on credit exhaustion |
| Oracle current VM | already paid | 15 min | ⚠️ 208 MB free, risks OOMing kairos-backend |
| Fly.io / Railway | ~€5-10/mo | 20 min | Fine if you want managed |

Owner picked **Lightning Studio** initially but it was out of credits
and the studio auto-slept. Fallback recommendation: **Hetzner CX22
(€3.85/mo)** — 4 GB RAM, 40 GB SSD, dedicated. Below is the flow.

## One-shot install on a fresh Ubuntu 22.04 / 24.04

```bash
# 1. Base image setup (as root, one time)
apt-get update && apt-get install -y curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 2. Run the installer
git clone https://github.com/kpkcf47jr2-lab/kaizen-app.git /opt/kaizen-app
sudo bash /opt/kaizen-app/deploy/install.sh

# 3. Edit env with real secrets
sudo nano /etc/kaizen-app.env
# ⚠ Set KAIZEN_VAULT_PASSPHRASE (≥16 random chars) and KAIZEN_LLM_API_KEY.
#   All other keys can stay empty; features degrade gracefully.

# 4. Restart to pick up the env
sudo systemctl restart kaizen-app

# 5. Verify
curl http://127.0.0.1:4711/healthz         # {"ok":true,...}
sudo journalctl -u kaizen-app -f            # follow logs
```

## Updating

```bash
sudo bash /opt/kaizen-app/deploy/install.sh
# Pulls latest master, npm install, restart service. Idempotent.
```

## Vault backup (CRITICAL)

`data/vaults/*.json` holds each agent's mnemonic sealed with
`KAIZEN_VAULT_PASSPHRASE`. If you lose both the passphrase AND the
vault files, funds in agent wallets are irrecoverable.

```bash
# Backup vaults + agent registry + memory DBs
sudo tar czf ~/kaizen-backup-$(date +%F).tar.gz /opt/kaizen-app/data
# Copy off-box (encrypt at rest with age / gpg first)
```

## Optional: nginx reverse proxy + TLS

If you want `kaizen.example.com` → the backend:

```nginx
server {
    server_name kaizen.example.com;
    location / { proxy_pass http://127.0.0.1:4711; }
    listen 443 ssl;  # certbot fills the rest
}
```

Then `certbot --nginx -d kaizen.example.com`.

## Dashboard (frontend)

Two options:

1. **Ship it to Cloudflare Pages** — the Vite build only needs
   `VITE_API_BASE=https://kaizen.example.com` at build time. Same
   `wrangler pages deploy dist` flow as `kairos-wallet`.
2. **Same-origin**: nginx `location /` → static dashboard bundle,
   `location /api/` → backend. Skips CORS + subdomain.

Ships in a follow-up commit — for MVP the dashboard runs on
`localhost:4712` with vite dev proxy against the deployed backend.
