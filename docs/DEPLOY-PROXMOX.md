# Deploying the ERP on a Proxmox LXC container

A complete, copy-paste guide: one Debian LXC container running MySQL, the API, the web app, Nginx and
backups — no Docker needed.

---

## 0. What runs where

| Part | What it is | Port (inside the container) |
|---|---|---|
| **MySQL 8.4 LTS** | Database | 3306 (localhost only) |
| **API** | NestJS 11 on Node.js — `apps/api/dist/main.js` | 4000 (localhost only) |
| **Web** | Next.js 16 — `apps/web` (`next start`) | 3000 (localhost only) |
| **Nginx** | Reverse proxy, HTTPS | 80 / 443 (the only open ports) |
| **Chromium** | Headless, for PDF export (brochures, invoices, reports) | — |
| **Files** | Uploads stored on disk in `/opt/erp/uploads` | — |

Browser → Nginx → `/api/*` goes to the API (4000), everything else to the web app (3000).

## 1. Versions (tested with)

| Software | Version | Notes |
|---|---|---|
| Proxmox VE | 8.x | |
| Container OS | **Debian 12 (bookworm)** | Use Debian, not Ubuntu: Ubuntu only ships Chromium as a snap, which doesn't work in an LXC. |
| Node.js | **24.x** (tested 24.21) | From NodeSource |
| pnpm | **10.15.0** | Via corepack (pinned in `package.json`) |
| MySQL | **8.4 LTS** (tested 8.4.11) | Official MySQL APT repo. MariaDB is **not** supported. |
| Next.js | 16.3.6 | installed by pnpm |
| React | 19.3.0 | installed by pnpm |
| NestJS | 11.2.x | installed by pnpm |
| Prisma | 6.19.3 | installed by pnpm |
| playwright-core | 1.63.0 | drives the system Chromium for PDFs |
| Chromium | Debian package (130+) | `/usr/bin/chromium` |
| Nginx | Debian package (1.22) | |

## 2. Create the container (on the Proxmox host)

**Recommended size:** 4 vCPU · **8 GB RAM** (the web build needs ~4 GB; runtime uses ~1.5 GB) · 2 GB swap · 40 GB disk.

### Option A — Proxmox web UI

1. *local* storage → **CT Templates** → **Templates** → download `debian-12-standard`.
2. **Create CT**:
   - Hostname `erp`, set a root password (or SSH key)
   - **Unprivileged container: yes** (default)
   - Template: `debian-12-standard_12.x_amd64`
   - Disk 40 GB · CPU 4 · Memory 8192 · Swap 2048
   - Network: `vmbr0`, static IP (e.g. `192.168.1.50/24`, gateway `192.168.1.1`)
   - DNS: your router or `1.1.1.1`
3. **Options → Features**: enable **nesting** (needed by systemd in newer Debian containers).
4. Start the container.

### Option B — Proxmox shell

```bash
pveam update
pveam download local debian-12-standard_12.7-1_amd64.tar.zst   # check exact name with: pveam available | grep debian-12

pct create 120 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname erp --cores 4 --memory 8192 --swap 2048 \
  --rootfs local-lvm:40 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1 \
  --unprivileged 1 --features nesting=1 --onboot 1 \
  --password
pct start 120
pct enter 120
```

> Everything from here on runs **inside the container** as root.

## 3. Base system

```bash
apt update && apt -y full-upgrade
apt -y install curl wget gnupg ca-certificates git unzip rsync nano ufw cron \
  locales tzdata build-essential

# Timezone (change to yours)
timedatectl set-timezone Asia/Karachi
dpkg-reconfigure -f noninteractive tzdata

# Locale
sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
```

## 4. Node.js 24 + pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt -y install nodejs
node -v            # v24.x

corepack enable
corepack prepare pnpm@10.15.0 --activate
pnpm -v            # 10.15.0
```

## 5. MySQL 8.4 LTS

```bash
cd /tmp
wget https://dev.mysql.com/get/mysql-apt-config_0.8.33-1_all.deb   # newest: https://dev.mysql.com/downloads/repo/apt/
DEBIAN_FRONTEND=noninteractive dpkg -i mysql-apt-config_0.8.33-1_all.deb
# If a dialog appears: choose "MySQL Server & Cluster" → "mysql-8.4-lts" → OK
apt update
apt -y install mysql-server      # asks for a root password — set a strong one
mysql --version                  # 8.4.x
```

Keep MySQL local only and tune it for this box:

```bash
cat > /etc/mysql/mysql.conf.d/erp.cnf <<'EOF'
[mysqld]
bind-address = 127.0.0.1
character-set-server = utf8mb4
collation-server = utf8mb4_0900_ai_ci
innodb_buffer_pool_size = 1G
max_connections = 200
EOF
systemctl restart mysql
```

Create the database and user (replace the password):

```bash
mysql -uroot -p <<'EOF'
CREATE DATABASE erp CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'erp'@'localhost' IDENTIFIED BY 'CHANGE_ME_DB_PASSWORD';
GRANT ALL PRIVILEGES ON erp.* TO 'erp'@'localhost';
FLUSH PRIVILEGES;
EOF
```

> The `erp` user needs full rights on `erp.*`; Prisma migrations create and alter tables.

## 6. Chromium and fonts (PDF export)

```bash
apt -y install chromium fonts-inter fonts-dejavu-core fonts-liberation2 fonts-noto-color-emoji
ls -l /usr/bin/chromium
fc-list | grep -i inter    # brochures look best with Inter installed
```

The API already starts Chromium with `--no-sandbox`, so it works in an unprivileged container.

## 7. Get the code onto the container

Create a service user and the app folder:

```bash
adduser --system --group --home /opt/erp --shell /bin/bash erp
mkdir -p /opt/erp && chown erp:erp /opt/erp
```

**Option A — from your dev machine with rsync** (run this **on your dev machine**, not in the container):

```bash
cd /home/pc/vb/erp-mode
rsync -av --delete \
  --exclude node_modules --exclude '.next' --exclude dist --exclude uploads \
  --exclude test-results --exclude '.env' \
  ./ root@192.168.1.50:/opt/erp/
```

**Option B — from Git**:

```bash
sudo -u erp git clone https://your-git-server/erp.git /opt/erp
```

Then, back in the container:

```bash
chown -R erp:erp /opt/erp
```

## 8. Configuration (`/opt/erp/.env`)

Generate secrets:

```bash
openssl rand -base64 48   # use for JWT_ACCESS_SECRET
openssl rand -base64 48   # use for FIELD_ENCRYPTION_KEY
```

Create the file (replace every `CHANGE_ME` and the domain):

```bash
cat > /opt/erp/.env <<'EOF'
# ── Database ──
DATABASE_URL=mysql://erp:CHANGE_ME_DB_PASSWORD@127.0.0.1:3306/erp

# ── Public address (used in links, QR codes, emails) ──
WEB_URL=https://erp.example.com
CORS_ORIGINS=https://erp.example.com

# ── Security (keep these secret; never change FIELD_ENCRYPTION_KEY after go-live) ──
JWT_ACCESS_SECRET=CHANGE_ME_LONG_RANDOM_1
FIELD_ENCRYPTION_KEY=CHANGE_ME_LONG_RANDOM_2
ACCESS_TTL=15m
REFRESH_TTL_DAYS=14
LOGIN_RATE_LIMIT=10

# ── Files: stored on the container disk ──
STORAGE=local
UPLOAD_DIR=/opt/erp/uploads

# ── PDF export ──
CHROME_PATH=/usr/bin/chromium

# ── First admin account (created by the seed step) ──
SEED_ADMIN_EMAIL=admin@erp.local
SEED_ADMIN_PASSWORD=CHANGE_ME_ADMIN_PASSWORD

# ── Runtime ──
NODE_ENV=production
PORT=4000
MALLOC_ARENA_MAX=2
EOF
chown erp:erp /opt/erp/.env && chmod 600 /opt/erp/.env
mkdir -p /opt/erp/uploads && chown erp:erp /opt/erp/uploads
```

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | MySQL connection string |
| `WEB_URL` | Public URL of the site (QR codes, email links, kiosk pairing links) |
| `CORS_ORIGINS` | Same as `WEB_URL` (comma-separate if several) |
| `JWT_ACCESS_SECRET` | Signs login tokens |
| `FIELD_ENCRYPTION_KEY` | Encrypts sensitive fields (device PINs etc.) — **back it up; losing it makes those fields unreadable** |
| `LOGIN_RATE_LIMIT` | Logins per IP per minute (keep 10 in production) |
| `STORAGE` / `UPLOAD_DIR` | `local` + absolute folder for uploads (or `s3` + `MINIO_*` for S3/MinIO) |
| `CHROME_PATH` | Chromium binary for server-side PDFs; empty = PDF export off |
| `JOBS` | Set `off` to disable background jobs (only if you run a second API instance) |

## 9. Install, build, migrate, seed

```bash
su - erp
cd /opt/erp

pnpm install --frozen-lockfile
pnpm prisma generate

# Build everything (shared packages, API, web). API_URL is read at build time by the web app.
export API_URL=http://127.0.0.1:4000
export NODE_OPTIONS=--max-old-space-size=4096
pnpm build

# Create / update the database schema
pnpm prisma migrate deploy

# First install only: default roles, chart of accounts, master data, admin user
pnpm db:seed

exit
```

## 10. Run as services (systemd)

**API:**

```bash
cat > /etc/systemd/system/erp-api.service <<'EOF'
[Unit]
Description=ERP API (NestJS)
After=network.target mysql.service
Requires=mysql.service

[Service]
User=erp
Group=erp
WorkingDirectory=/opt/erp
EnvironmentFile=/opt/erp/.env
ExecStart=/usr/bin/node apps/api/dist/main.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
```

**Web:**

```bash
cat > /etc/systemd/system/erp-web.service <<'EOF'
[Unit]
Description=ERP Web (Next.js)
After=network.target erp-api.service

[Service]
User=erp
Group=erp
WorkingDirectory=/opt/erp/apps/web
Environment=NODE_ENV=production
Environment=API_URL=http://127.0.0.1:4000
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
ExecStart=/opt/erp/apps/web/node_modules/.bin/next start -p 3000 -H 127.0.0.1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Start them:

```bash
systemctl daemon-reload
systemctl enable --now erp-api erp-web
systemctl status erp-api erp-web --no-pager
curl -s http://127.0.0.1:4000/api/health      # {"status":"ok",...}
curl -sI http://127.0.0.1:3000/login | head -1   # HTTP/1.1 200 OK
```

Logs:

```bash
journalctl -u erp-api -f
journalctl -u erp-web -f
```

## 11. Nginx reverse proxy

```bash
apt -y install nginx

cat > /etc/nginx/sites-available/erp <<'EOF'
server {
    listen 80;
    server_name erp.example.com;          # or the container IP

    client_max_body_size 30m;             # uploads (photos, PDFs, logo)

    # API directly (also live notifications / SSE)
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;              # needed for live notifications
        proxy_read_timeout 1h;
    }

    # Web app
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

ln -sf /etc/nginx/sites-available/erp /etc/nginx/sites-enabled/erp
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Open `http://<container-ip>/` and sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, then **change the admin password** (My account).

## 12. HTTPS

Pick the one that matches your network:

**A. Public domain pointing at your IP (ports 80/443 forwarded to the container):**

```bash
apt -y install certbot python3-certbot-nginx
certbot --nginx -d erp.example.com --redirect -m you@example.com --agree-tos -n
systemctl list-timers | grep certbot     # auto-renewal is installed
```

**B. Behind another reverse proxy** (Nginx Proxy Manager, Traefik, Cloudflare Tunnel): point it to `http://<container-ip>:80` and let that proxy do HTTPS. Keep `WEB_URL` / `CORS_ORIGINS` set to the public `https://` address.

**C. LAN only:** plain `http://<container-ip>` works. Set `WEB_URL=http://<container-ip>` and `CORS_ORIGINS=http://<container-ip>` in `.env`, then `systemctl restart erp-api`.

> Camera QR scanning and NFC on phones (kiosk, intake) need **HTTPS** in the browser — use A or B for kiosks.

## 13. Firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

MySQL (3306), the API (4000) and the web app (3000) stay on localhost only.

## 14. Backups

The repo includes `scripts/backup-lxc.sh`: a MySQL dump plus a tarball of `uploads`, keeping 14 days.

```bash
# Let root's mysqldump log in without a password on the command line
cat > /root/.my.cnf <<'EOF'
[client]
user=erp
password=CHANGE_ME_DB_PASSWORD
EOF
chmod 600 /root/.my.cnf

chmod +x /opt/erp/scripts/backup-lxc.sh
/opt/erp/scripts/backup-lxc.sh          # test once
ls -lh /var/backups/erp/db /var/backups/erp/files

# Nightly at 02:00
( crontab -l 2>/dev/null; echo "0 2 * * * UPLOAD_DIR=/opt/erp/uploads /opt/erp/scripts/backup-lxc.sh >> /var/log/erp-backup.log 2>&1" ) | crontab -
```

**Also back up, off the container:**
- `/opt/erp/.env` (especially `FIELD_ENCRYPTION_KEY` and `JWT_ACCESS_SECRET`)
- `/var/backups/erp` → copy to your NAS / Proxmox Backup Server
- Proxmox level: **Datacenter → Backup → Add** a scheduled `vzdump` of the container (snapshot mode)

**Restore:**

```bash
systemctl stop erp-api erp-web
gunzip -c /var/backups/erp/db/erp-YYYYMMDD-HHMM.sql.gz | mysql -uerp -p erp
tar -xzf /var/backups/erp/files/uploads-YYYYMMDD-HHMM.tar.gz -C /opt/erp
chown -R erp:erp /opt/erp/uploads
systemctl start erp-api erp-web
```

## 15. Updating to a new version

```bash
# 1. Backup first
/opt/erp/scripts/backup-lxc.sh

# 2. Copy the new code (from your dev machine, same rsync as step 7 — it keeps .env and uploads)
#    or: sudo -u erp git -C /opt/erp pull

# 3. Rebuild and migrate
chown -R erp:erp /opt/erp
su - erp -c 'cd /opt/erp && pnpm install --frozen-lockfile && pnpm prisma generate \
  && API_URL=http://127.0.0.1:4000 NODE_OPTIONS=--max-old-space-size=4096 pnpm build \
  && pnpm prisma migrate deploy'

# 4. Restart
systemctl restart erp-api erp-web
curl -s http://127.0.0.1:4000/api/health
```

> Never run `pnpm db:seed` again on a live system unless told to — it only fills an empty database.
> Never use `prisma migrate dev` or `migrate reset` in production; only `prisma migrate deploy`.

## 16. Checks after install

| Check | How |
|---|---|
| API alive | `curl -s http://127.0.0.1:4000/api/health` |
| Login works | Open the site, sign in as the seeded admin |
| PDFs work | Catalog → any item → **Brochure (PDF)**, or print an invoice as PDF |
| Uploads work | Admin → Branding → upload a logo; it shows in the sidebar |
| Emails | Admin → Settings → SMTP, then Admin → Background jobs → run outbox |
| Kiosk | HR → Kiosk Stations → **Pair a device** (needs HTTPS for camera) |
| Background jobs | Admin → Background jobs shows the nightly run after 02:00 |

## 17. Troubleshooting

| Problem | Fix |
|---|---|
| `pnpm build` killed / out of memory | Give the container 8 GB RAM + swap; keep `NODE_OPTIONS=--max-old-space-size=4096` |
| PDF export error "needs CHROME_PATH" | Set `CHROME_PATH=/usr/bin/chromium` in `.env`, `systemctl restart erp-api` |
| PDF export error "renderer failed to start" | `apt -y install chromium`; check `journalctl -u erp-api` |
| Brochures use a wide/odd font | `apt -y install fonts-inter` and restart the API |
| "Too many requests" on login | Wait a minute (limit is 10 logins/IP/min); check the proxy passes `X-Forwarded-For` |
| Images/logo disappear after restart | `UPLOAD_DIR` must be the absolute path `/opt/erp/uploads` owned by `erp` |
| Web shows but data fails to load | `systemctl status erp-api`; check `DATABASE_URL`; `API_URL` must be `http://127.0.0.1:4000` at build and runtime |
| Live notifications don't arrive | Keep `proxy_buffering off` on `/api/` in Nginx |
| Links/QR codes point to `localhost` | Set `WEB_URL` to the public address and restart the API |
| `Access denied` from Prisma | Re-check the DB password in `DATABASE_URL` and the `GRANT` in step 5 |

## 18. Command cheat-sheet

```bash
systemctl restart erp-api erp-web          # restart app
systemctl status  erp-api erp-web --no-pager
journalctl -u erp-api -n 200 --no-pager    # last API logs
journalctl -u erp-web -n 200 --no-pager
su - erp -c 'cd /opt/erp && pnpm prisma migrate status'   # pending migrations?
mysql -uerp -p erp                           # database shell
/opt/erp/scripts/backup-lxc.sh               # backup now
nginx -t && systemctl reload nginx           # after editing the proxy
```
