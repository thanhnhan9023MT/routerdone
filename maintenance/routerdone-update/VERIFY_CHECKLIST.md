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
git grep -n -i -E "biz100m|llmgateway|llm\.biz100m|gpt-5\.5\.fallback" -- \
  ':!maintenance/routerdone-update/REBRAND_RULES.md' \
  ':!maintenance/routerdone-update/VERIFY_CHECKLIST.md' \
  ':!maintenance/routerdone-update/sync-routerdone-from-upstream.ps1'
git grep -n -i -P "thoa100m(?!/routerdone(?:\\.git)?(?=$|[/#?[:space:]\\\">):,]))" -- \
  ':!LICENSE' ':!.github/FUNDING.yml' ':!maintenance/routerdone-update/**'
```

Expected:
- Legacy/private brand va combo: 0 match ngoai cac file governance mo ta replacement.
- Exact canonical repo slug `thoa100m/routerdone` duoc phep trong source, URL,
  installer, updater va release commands.
- `thoa100m` ngoai canonical slug chi duoc phep trong metadata allowlist
  `LICENSE`, `.github/FUNDING.yml` va tai lieu governance.

## 3. Domain / IP / Tunnel Scan

```bash
git grep -n -i -E "biz100m\.com|llm\.biz100m" -- \
  ':!maintenance/routerdone-update/REBRAND_RULES.md' \
  ':!maintenance/routerdone-update/VERIFY_CHECKLIST.md' \
  ':!maintenance/routerdone-update/sync-routerdone-from-upstream.ps1'
```

Expected: 0 match ngoai governance replacement rules. Cloudflare quick tunnels va
Tailscale la tinh nang ket noi duoc ho tro, khong phai private-domain leak; cac URL
cu the cua ca nhan van phai bi secret/domain review bat lai.

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
- `AGENTS.md` (internal owner/repository/Codekit metadata)
- `cloud/` (Cloudflare worker, hardcoded secret)
- `skills/` (upstream-router CLI skills)
- `tester/`, `task-bootstrap-cache-design.txt`, `gitbook/`, `images/`, `cli/`
- `.git/` (no history)

## 12. GitHub Release +1

Sau khi verify pass va push len `main`, tao annotated tag patch +1:

```bash
git tag -a vX.Y.Z -m "RouterDone vX.Y.Z"
git push origin vX.Y.Z
gh release view vX.Y.Z --repo thoa100m/routerdone
```

Neu external automation chua tao release, tao tu tag da verify thay vi de `gh`
tao lightweight tag:

```bash
gh release create vX.Y.Z --repo thoa100m/routerdone --verify-tag \
  --title "RouterDone vX.Y.Z" --notes "RouterDone vX.Y.Z"
gh release view vX.Y.Z --repo thoa100m/routerdone
gh release list --repo thoa100m/routerdone --limit 3
```

Expected:
- Tag moi la annotated tag va patch +1 so voi Latest release truoc do.
- Tag va release cung tro vao release commit tren `main`.
- Release moi hien la Latest.
