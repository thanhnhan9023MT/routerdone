# Verify Checklist

Chay tat ca truoc khi push public. Khong push khi bat ky muc nao fail.

## 1. Secret Scan

```bash
rg -n -i "sk-[a-zA-Z0-9]{20,}" --glob "!node_modules" --glob "!.next" --glob "!package-lock.json" --glob "!*.patch" .
rg -n -i "api[_-]?key\s*=\s*[\"'][^\"']{15,}" --glob "!node_modules" --glob "!.next" .
rg -n -i "[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}" --glob "!node_modules" --glob "!.next" --glob "!package-lock.json" .
```

Expected:
- Khong co real API key, token, OAuth secret.
- `x@y.com` trong test fixture = OK.
- `sk-mach01-key01...` trong test fixture = OK (fake).
- `endpoint-proxy-api-key-secret` / `endpoint-proxy-salt` = fallback
  default, ghi trong residual risk. .env.example yeu cau set real secret.

## 2. Brand Scan

```bash
rg -n -i "biz100m|llmgateway|thoa100m|llm\.biz100m|gpt-5\.5\.fallback" --glob "!node_modules" --glob "!.next" .
rg -n -i "upstream|upstream-router" --glob "!node_modules" --glob "!.next" --glob "!*.patch" --glob "!LICENSE" .
```

Expected:
- Biz100M/thoa100m/llm.biz100m/gpt-5.5.fallback: 0 match (tru README scan example).
- upstream/upstream-router: 0 match ngoai patch files + LICENSE.

## 3. Domain / IP / Tunnel Scan

```bash
rg -n -i "biz100m\.com|llm\.biz100m|trycloudflare|\.tailscale" --glob "!node_modules" --glob "!.next" .
```

Expected: 0 match.

## 4. Patches Apply Check

Clone fresh upstream, apply tat ca patch theo PATCH_ORDER.md:

```bash
git clone --depth 1 --branch v<version> https://github.com/decolua/${"9"}router.git /tmp/9r-check
cd /tmp/9r-check
git apply /path/to/routerdone/patches/routerdone-custom.patch
# apply features theo thu tu
git apply /path/to/routerdone/patches/features/*.patch
git status --short
```

Expected: tat ca apply OK, khong conflict.

## 5. Dokploy Compose Preflight

```bash
npm run verify:dokploy
```

Expected:
- `docker-compose.dokploy.yml` khong co literal `\n`.
- `docker compose -p routerdone-routerdone-ed6gok -f docker-compose.dokploy.yml config` parse thanh cong.
- Service name la `routerdone`, khong phai `app`.
## 6. Docker Build

```bash
docker build -t routerdone .
```

Expected: build thanh cong, khong loi.

## 7. Docker Compose Up

```bash
cp .env.example .env
# set JWT_SECRET, INITIAL_PASSWORD, API_KEY_SECRET, MACHINE_ID_SALT
docker compose up -d
```

Expected: container chay, khong crash loop.

## 8. Health Smoke Test

```bash
curl http://localhost:20128/api/health
```

Expected: 200 OK, JSON response.

## 9. API Smoke Test

```bash
curl http://localhost:20128/v1/models -H "Authorization: Bearer YOUR_KEY"
```

Expected: 200 OK, model list.

## 10. Dokploy Notes

Run preflight before push/release:

```bash
npm run verify:dokploy
```

Expected:
- Compose file is `docker-compose.dokploy.yml`.
- Top-level service name is `routerdone` because Dokploy domain mapping attaches to service `routerdone`.
- File uses real newlines, not literal `\n` sequences.
- `docker compose -p routerdone-routerdone-ed6gok -f docker-compose.dokploy.yml config` passes with required env values.

Dokploy settings:
- Compose file: `docker-compose.dokploy.yml`
- Service: `routerdone`
- Env: copy tu `.env.example`, set BASE_URL = public URL.
- AUTH_COOKIE_SECURE=true cho HTTPS.
- REQUIRE_API_KEY=true cho public API.
- Persistent volume: `/app/data`.

## 11. Internal Automation Excluded

Xac nhan khong co:
- `.agents/` (Codekit)
- `rules/` (release/patch gate)
- `AGENTS.md` (thoa100m/llmGateway)
- `cloud/` (Cloudflare worker, hardcoded secret)
- `skills/` (upstream-router CLI skills)
- `tester/`, `task-bootstrap-cache-design.txt`, `gitbook/`, `images/`, `cli/`
- `.git/` (no history)

## 12. GitHub Release +1

Sau khi verify pass va push len `main`, tao release patch +1:

```bash
gh release list --repo thoa100m/routerdone --limit 1
gh release create vX.Y.Z --repo thoa100m/routerdone --target main --title "RouterDone vX.Y.Z" --notes "Upstream upstream sync + RouterDone rebrand + verify green"
gh release view vX.Y.Z --repo thoa100m/routerdone
gh release list --repo thoa100m/routerdone --limit 3
```

Expected:
- Tag moi la patch +1 so voi Latest release truoc do.
- Release tro vao `main`.
- Release moi hien la Latest.
