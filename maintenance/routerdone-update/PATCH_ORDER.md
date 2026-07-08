# Patch Order

Thu tu apply patch — phai dung thu tu nay, giong Docker build. Docker build
applies files trong `patches/features/` theo **shell glob order** (tên file sort
ASCII), cho nen bang duoi day theo đúng thứ tự sort đó.

## 1. Main Patch

```
git apply patches/routerdone-custom.patch
```

Patch chinh: rebrand + tuy chinh dashboard, CLI tools, config, MITM,
layout, manifest, public page, Sidebar, Header, settings.

## 2. Feature Patches (shell glob order, z-prefix = apply sau)

| # | File | Chuc nang |
|---|------|-----------|
| 1 | `console-log-retention.patch` | Gioi han + prune console log |
| 2 | `force-stream-fix.patch` | Fix force-stream cho combo |
| 3 | `provider-auto-heal.patch` | Auto-heal provider khi loi |
| 4 | `quota-auto-manage.patch` | Auto-manage quota |
| 5 | `z-adaptive-timeout-v2.patch` | Adaptive timeout v2 |
| 6 | `zz-runtime-observability.patch` | Runtime observability |
| 7 | `zzz-scored-rtk.patch` | Scored RTK filter + dedup |
| 8 | `zzza-progressive-rtk.patch` | Progressive RTK tiering (phu thuoc #7) |
| 9 | `zzzzb-quota-default-provider.patch` | Default provider filter trong Quota |
| 10 | `zzzzc-stream-error-fallback.patch` | Combo fallback khi SSE error |
| 11 | `zzzzd-redirect-gpt54mini-to-combo.patch` | Redirect gpt-5.4-mini -> helper.fallback |
| 12 | `zzzze-model-redirect-ui.patch` | Model Redirect UI card (Profile) |
| 13 | `zzzzf-sanitize-tool-call-arguments.patch` | Sanitize tool call args |
| 14 | `zzzzg-normalize-output-text-content.patch` | Normalize output_text content |
| 15 | `zzzzh-gmt7-console-timestamps.patch` | GMT+7 console timestamps |
| 16 | `zzzzi-compatible-custom-model-selector.patch` | Compatible custom model selector |
| 17 | `zzzzj-normalize-nonstream-content-array.patch` | Normalize non-stream content array |
| 18 | `zzzzk-strip-thinking-tags-content.patch` | Strip thinking tags content |
| 19 | `zzzzl-recent-requests-context.patch` | Recent requests context |
| 20 | `zzzzm-recent-requests-collapse-actual-model.patch` | Collapse actual model trong recent requests |
| 21 | `zzzzn-active-request-elapsed.patch` | Active request elapsed time |
| 22 | `zzzzo-recent-requests-no-active-row.patch` | An row active trong recent requests |
| 23 | `zzzzp-dedup-usage-save.patch` | Dedup usage save |

## Luu y thu tu

- `zzza-progressive-rtk.patch` phai apply SAU `zzz-scored-rtk.patch`
  (progressive phu thuoc scored).
- PowerShell `Sort-Object Name` co the sap xep `zzza` truoc `zzz-`
  (khac ASCII). Luon apply `zzz-scored-rtk` truoc `zzza-progressive-rtk`.
- Z-prefix dai hon = apply sau (glob sort ASCII: `zzz` < `zzza` < `zzzzb`...).
  Cac patch `zzzzj..zzzzp` deu la recent-requests/usage/ui polish, apply
  theo dung ten file de khop Docker build.

## Rebase History

| Ngay | Upstream | Patch rebase | Ghi chu |
|------|----------|--------------|---------|
| 2026-06-24 | v0.5.8 | All patches | Khoi tao RouterDone public export |
