# Installation Guide

Detailed install instructions for RouterDone by scenario. Pick the one that matches you.

- Scenario A: Personal computer with Docker (easiest).
- Scenario B: VPS / server with Docker (public, always-on).
- Scenario C: Dokploy (managed Compose deploy).
- Scenario D: Local development from source (no Docker).

Default app port: `20128`. Default URL: `http://localhost:20128`.

---

## Prerequisites

For Docker scenarios (A, B, C):
- Docker Engine 24+ and Docker Compose v2 (`docker compose`, not `docker-compose`).
- 2 GB free RAM, 2 GB free disk.

For local dev (D):
- Node.js 20 or 22.
- npm 10+.

Generate secrets (Linux/macOS):

```bash
openssl rand -hex 32
```

Generate secrets (Windows PowerShell):

```powershell
-join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
```

Required secrets: `JWT_SECRET`, `INITIAL_PASSWORD`, `API_KEY_SECRET`, `MACHINE_ID_SALT`.

---

## Scenario A: Personal Computer (Docker)

Use this to run RouterDone locally on Windows, macOS, or Linux.

1. Get the code:

```bash
git clone https://github.com/thoa100m/routerdone.git
cd routerdone
```

2. Create `.env`:

```bash
cp .env.example .env
```

3. Edit `.env` and set the 4 required secrets. Keep these defaults for local:

```text
PORT=20128
BASE_URL=http://localhost:20128
NEXT_PUBLIC_BASE_URL=http://localhost:20128
AUTH_COOKIE_SECURE=false
REQUIRE_API_KEY=false
```

4. Start:

```bash
docker compose up --build -d
```

5. Open `http://localhost:20128` and sign in with `INITIAL_PASSWORD`.

6. Stop / restart:

```bash
docker compose stop
docker compose start
docker compose down        # remove containers (keeps named volumes/data)
```

Port already in use? Change the host port without touching the app:

```bash
PORT=20130 docker compose up -d
# then open http://localhost:20130
```

Windows note: run Docker Desktop first. Use PowerShell, set env vars with `$env:NAME='value'` if you do not use an `.env` file.

---

## Scenario B: VPS / Server (Docker, public)

Use this for an always-on public instance (Ubuntu/Debian example).

1. Install Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

2. Clone and enter:

```bash
git clone https://github.com/thoa100m/routerdone.git
cd routerdone
cp .env.example .env
```

3. Edit `.env` for public use:

```text
JWT_SECRET=<openssl rand -hex 32>
INITIAL_PASSWORD=<long admin password>
API_KEY_SECRET=<openssl rand -hex 32>
MACHINE_ID_SALT=<openssl rand -hex 32>
NODE_ENV=production
PORT=20128
TZ=UTC
BASE_URL=https://your-domain.example
NEXT_PUBLIC_BASE_URL=https://your-domain.example
AUTH_COOKIE_SECURE=true
REQUIRE_API_KEY=true
```

4. Start:

```bash
docker compose up --build -d
```

5. Put a reverse proxy with HTTPS in front (recommended). Caddy example:

```text
your-domain.example {
    reverse_proxy 127.0.0.1:20128
}
```

Nginx example (proxy block):

```nginx
server {
    server_name your-domain.example;
    location / {
        proxy_pass http://127.0.0.1:20128;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

6. Verify:

```bash
curl https://your-domain.example/api/health
```

Security for public servers:
- Keep `REQUIRE_API_KEY=true` so the `/v1/*` API needs a key.
- Keep `AUTH_COOKIE_SECURE=true` (HTTPS only cookies).
- Do not expose port `20128` directly to the internet; terminate TLS at the proxy.
- Back up the `routerdone-data` and `routerdone-data-home` volumes.

---

## Scenario C: Dokploy

Use this for a managed Compose deploy via Dokploy.

1. In Dokploy, create a new application -> Docker Compose.
2. Point it at this repository, compose file `docker-compose.yml`.
3. Set environment variables from `.env.example` (the 4 secrets are required).
4. Set `BASE_URL` and `NEXT_PUBLIC_BASE_URL` to your public app URL.
5. For public HTTPS:

```text
AUTH_COOKIE_SECURE=true
REQUIRE_API_KEY=true
```

6. Add persistent volumes:

```text
/app/data
/app/data-home
```

7. Deploy, then verify `/api/health`.

More detail: `docs/DOKPLOY.md`.

---

## Scenario D: Local Development (from source)

Use this to develop or test without Docker.

1. Install deps:

```bash
git clone https://github.com/thoa100m/routerdone.git
cd routerdone
npm install
```

2. Run dev server:

```bash
npm run dev
# http://localhost:20128
```

3. Production build and run:

```bash
npm run build
npm run start
```

Notes:
- `better-sqlite3` is optional. If native build tools are missing, RouterDone falls back to `sql.js` at runtime.
- Set secrets via environment variables or an `.env` file before `npm run start` for production.
- Windows: if `next build` tries to scan your home directory and fails with `EPERM ... C:\Users\...`, run the build with a scoped `HOME`/`USERPROFILE` pointing at a folder inside the repo, or build inside Docker (Scenario A).

---

## Versions And Updating

RouterDone tracks upstream 9Router and republishes a clean, rebranded build.

- Releases are tagged `vMAJOR.MINOR.PATCH` (for example `v0.5.9`).
- Each push to `main` gets a GitHub Release with the PATCH bumped by +1.
- Pick a specific version:

```bash
git clone --branch v0.5.9 https://github.com/thoa100m/routerdone.git
```

- See all versions: `https://github.com/thoa100m/routerdone/releases`.

To update an existing deployment to the latest code:

```bash
cd routerdone
git pull
docker compose up --build -d
curl http://localhost:20128/api/health
```

Maintainers syncing from a new upstream release: follow `maintenance/routerdone-update/`.

---

## Post-Install Checklist

1. Sign in with `INITIAL_PASSWORD`.
2. Add at least one provider with credentials.
3. Create a combo (for example `helper.fallback`).
4. Create an API key in the dashboard.
5. Call the API:

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer YOUR_ROUTERDONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-provider/your-model","messages":[{"role":"user","content":"Hello"}]}'
```

6. Optional: configure Model Redirect (`docs/MODEL_REDIRECT.md`).
