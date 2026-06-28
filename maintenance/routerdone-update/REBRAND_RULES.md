# Rebrand Rules

Buoc rebrand chay SAU khi apply patch len fresh upstream clone.
Muc dich: chuyen tat ca brand tu upstream/Biz100M sang RouterDone,
xoa domain/secret/combo ca nhan, neutralize default.

## Bulk Replace (tat ca text files: .js, .json, .mjs, .md, .yml, .sh)

| Tim | Thay bang | Ghi chu |
|-----|----------|---------|
| `https://llm.biz100m.com` | `http://localhost:20128` | Xoa domain ca nhan |
| `llm.biz100m.com` | `localhost:20128` | Xoa domain ca nhan |
| `Biz100M LLM Gateway` | `RouterDone` | Ten hien thi |
| `Biz100M Gateway` | `RouterDone` | Ten hien thi |
| `Biz100M customers` | `RouterDone users` | Text user-facing |
| `Biz100M` | `RouterDone` | Con lai |
| `llmGateway` | `routerdone` | Repo name |
| `llmgateway` | `routerdone` | Repo name |
| `thoa100m` | `routerdone` | Owner name |
| `upstream` | `RouterDone` | Upstream brand -> RouterDone |
| `upstream-router` | `routerdone` | Upstream brand lowercase |
| `gpt-5.5.fallback` | `helper.fallback` | Combo ca nhan -> trung tinh |
| `UPSTREAM_ROUTER` | `ROUTERDONE` | Env var names (JCODE_UPSTREAM_ROUTER_API_KEY) |
| `patches/biz100m-custom.patch` | `patches/routerdone-custom.patch` | Patch filename ref |

## KHONG rebrand trong patch files

Patch files (`.patch`) giu `upstream`/`upstream-router` trong context lines
(` ` va `-`) de khop vanilla upstream. Chi rebrand trong added lines
(`+`). Thuc te: chi replace `Biz100M`, `gpt-5.5.fallback`,
`llm.biz100m.com`, `thoa100m` trong patch files (cac gia tri nay chi
xuat hien trong added lines, khong trong upstream context).

## KHONG rebrand

- `LICENSE`: giu `Copyright (c) 2024-2026 decolua and contributors`
  (attribution upstream MIT).
- `decolua/upstream-router` trong Dockerfile/pom reference: la upstream dep,
  khong phai brand ca nhan. Co the thay bang URL repo RouterDone moi
  neu muon, nhung khong bat buoc.

## Secret Neutralization

| File | Cu | Moi / Xu ly |
|------|-----|-------------|
| `.env.example` | `endpoint-proxy-api-key-secret` | `replace-with-openssl-rand-hex-32` |
| `.env.example` | `endpoint-proxy-salt` | `replace-with-openssl-rand-hex-32` |
| `.env.example` | `https://example-upstream.invalid` (CLOUD_URL) | de trong (blank) |
| `src/shared/utils/apiKey.js` | fallback `endpoint-proxy-api-key-secret` | giu nhu fallback runtime, .env.example yeu cau set |
| `src/shared/utils/machineId.js` | fallback `endpoint-proxy-salt` | nhu tren |
| `src/mitm/manager.js` | `routerdone-mitm-pwd` (ENCRYPT_SALT) | hardcoded salt, risk thap, ghi trong residual risk |

## Verify sau rebrand

```bash
rg -n -i "biz100m|llmgateway|thoa100m|llm\.biz100m|gpt-5\.5\.fallback" .
# Expected: chi match trong README (vi du scan regex)
rg -n -i "upstream|upstream-router" --glob '!*.patch' --glob '!LICENSE' .
# Expected: 0 match (da rebrand het)
```
