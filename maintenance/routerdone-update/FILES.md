# RouterDone File Map

Danh sach file lien quan den ban RouterDone public, nhom theo chuc nang.

## Nguon (snapshot upstream v0.5.8 + patches + rebrand)

| Thu muc/File | Trach nhiem |
|--------------|-------------|
| `src/` | Next.js App Router: pages, API routes, lib, mitm, models, shared, sse, store, i18n |
| `open-sse/` | SSE streaming: config, executors, handlers, rtk, services, translator, utils |
| `public/` | Static assets + i18n literals (30+ languages) |
| `package.json` | npm scripts + deps (name: routerdone-app, port 20128) |
| `next.config.mjs` | Next config (standalone, rewrites /v1/*, /codex/*) |
| `postcss.config.mjs` | PostCSS/Tailwind |
| `jsconfig.json` | JS path aliases |
| `eslint.config.mjs` | ESLint flat config |
| `custom-server.js` | HTTP server wrapper (IP derivation, XFF strip) |

## Patches (update inputs)

| File | Trach nhiem |
|------|-------------|
| `patches/routerdone-custom.patch` | Patch chinh: brand + tuy chinh |
| `patches/features/*.patch` | 16 feature patches (xem PATCH_ORDER.md) |
| `patches/features/README.md` | Huong dan apply feature patches |

## Public Install

| File | Trach nhiem |
|------|-------------|
| `Dockerfile` | Standalone build tu local source |
| `docker-compose.yml` | Local Docker Compose (2 volumes, healthcheck) |
| `dokploy.yaml` | Dokploy app definition |
| `captain-definition` | CapRover/Dokploy Dockerfile pointer |
| `.env.example` | Env template (required + optional vars) |
| `start.sh` | Quick Docker run script |
| `.gitignore` | Git ignore (data, logs, .next, node_modules, .env) |
| `.dockerignore` | Docker build context ignore |

## Docs

| File | Trach nhiem |
|------|-------------|
| `README.md` | Quick start, API flow, Model Redirect, Docker, Dokploy |
| `docs/DOKPLOY.md` | Dokploy deployment guide |
| `docs/MODEL_REDIRECT.md` | Model Redirect feature docs |
| `docs/ARCHITECTURE.md` | Architecture overview (tu upstream, da rebrand) |
| `LICENSE` | MIT (giu decolua attribution) |

## Tests

| File | Trach nhiem |
|------|-------------|
| `tests/` | Unit tests (vitest): translator, rtk, combo, upstream-error |
| `tests/package.json` | Test deps |
| `tests/vitest.config.js` | Vitest config |

## Scripts

| File | Trach nhiem |
|------|-------------|
| `scripts/injectDisplayToRegistry.mjs` | Inject display metadata vao registry |
| `scripts/migrate-registry.mjs` | Migrate registry files |
| `scripts/translate-readme.js` | README translation helper |

## Maintenance (update rules)

| File | Trach nhiem |
|------|-------------|
| `maintenance/routerdone-update/README.md` | Quy tac update tong quat |
| `maintenance/routerdone-update/PATCH_ORDER.md` | Thu tu apply patch |
| `maintenance/routerdone-update/REBRAND_RULES.md` | Quy tac rebrand |
| `maintenance/routerdone-update/VERIFY_CHECKLIST.md` | Checklist verify truoc push |
| `maintenance/routerdone-update/FILES.md` | File map (file nay) |
| `maintenance/routerdone-update/sync-routerdone-from-upstream.ps1` | Script update tu dong |

## Da Loai Bo (KHONG co trong public)

| Thu muc/File | Ly do |
|--------------|-------|
| `.git/` | Khong giu history cu |
| `.agents/` | Codekit internal |
| `rules/` | Release/patch gate thoa100m-specific |
| `AGENTS.md` | thoa100m/llmGateway/Codekit |
| `cloud/` | Cloudflare worker, hardcoded secret, owner infra |
| `skills/` | upstream CLI skills (branded) |
| `tester/` | Internal test scratch |
| `task-bootstrap-cache-design.txt` | Internal design doc |
| `gitbook/` | Upstream gitbook (empty) |
| `images/` | Upstream screenshot (branded) |
| `cli/` | Upstream CLI tool (empty) |
| `CHANGELOG.md` | Upstream history (decolua refs) |
| `DOCKER.md` | Upstream Docker doc (absorbed vao README) |
| `README.zh-CN.md` | Upstream i18n README (branded) |
| `.npmignore` | Khong publish npm |
| `.github/workflows/` | Upstream workflows (decolua/gitbook) |
| `scripts/test-combo-autoswitch.mjs` | Chua fake API key |
