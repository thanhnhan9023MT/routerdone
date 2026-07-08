# ZCode Coding Plan (1.5x Quota) via Sidecar

`glm-coding-plan` is a dormant provider that routes through a separate
**`zcodedone`** sidecar to reach the ZCode Coding Plan endpoint at
`zcode.z.ai/api/v1/zcode-plan/...`, which grants a **1.5x token quota**
compared to the plain `glm` provider (`api.z.ai/api/anthropic/v1/messages`).

The sidecar handles the parts RouterDone cannot:

- JWT coding-plan authentication (not API key)
- Aliyun 无痕 captcha solving (jsdom, no browser)
- Multi-account rotation and auto-switch when quota is exhausted
- Real token-unit quota reading (`billing/balance`, not percentage)

RouterDone only adds one dormant provider entry that points at the sidecar.

## Why dormant

The provider ships in the public catalog, but it is **inert** unless all of the
following are true on your deployment:

1. The `zcodedone` sidecar is running and reachable.
2. `ZCODE_GATEWAY_KEY` matches on both RouterDone and the sidecar.
3. A provider connection exists in your dashboard.
4. Your API key is whitelisted to `glm-coding-plan/...` via KeyLimitModal.

Anyone who downloads RouterDone from a public release will see the provider in
the gallery but cannot use it, because they do not have your sidecar, your
gateway key, your JWT coding plan, or your whitelisted API key.

## Deploy the sidecar

`zcodedone` is a private sidecar project (kept in its own repository). Build or
pull its container image per that project's instructions, then run it locally
or on your server. The sidecar must not be exposed publicly with the default
admin password.

### Local (recommended for single-user)

```bash
docker run -d --name zcodedone \
  -p 127.0.0.1:3000:3000 \
  -v "$(pwd)/data:/data" \
  -e ZCODE_ADMIN_KEY=<32-char-random> \
  -e ZCODE_GATEWAY_KEY=<64-char-random> \
  --restart unless-stopped \
  <zcodedone-image>
```

The `127.0.0.1:` bind keeps the sidecar off the public network. Open
`http://localhost:3000/admin` (sign in with `ZCODE_ADMIN_KEY`) and add your
z.ai coding-plan account.

### Dokploy / server

Deploy the sidecar as a separate Dokploy app (different service name from
RouterDone). Set the same env vars and restrict `/admin` to Tailscale or an IP
allow-list via the reverse proxy. In RouterDone, set:

```text
ZCODE_SIDECAR_URL=http://<sidecar-service>:3000/v1/messages
```

For Docker internal networking, use the sidecar service name (for example
`http://zcodedone:3000/v1/messages`).

## Connect RouterDone to the sidecar

1. Set `ZCODE_GATEWAY_KEY` to the same 64-char value on both sides.
2. Open `Dashboard -> Providers -> New` and pick
   **GLM Coding Plan (Sidecar)**.
3. API key = `ZCODE_GATEWAY_KEY`.
4. Click **Test**. It passes when the sidecar is reachable and the gateway key
   matches.
5. Use `glm-coding-plan/glm-5.2` (or another model from the registry) as the
   model in your client or combo.

## Lock the provider to your API key (recommended)

Open `Dashboard -> Endpoint -> <your-key> -> KeyLimitModal` and set
`allowedModels` to:

```text
{ "type": "model", "value": "glm-coding-plan/glm-5.2" }
```

Other API keys on the same deployment (if any) stay `type: "all"`. Even if
someone discovers your sidecar URL and gateway key, their API key is not
whitelisted to this model, so requests are rejected with `model_not_allowed`.

## Keep the sidecar up to date

The `zcodedone` sidecar has its own repository, which includes the helper to
sync with its upstream source. Run that helper inside the `zcodedone` repo
checkout — it is not part of RouterDone. See the `zcodedone` repo's
`maintenance/upstream-sync/` for the sync helper and instructions.

## Two quotas, do not confuse

| Quota | Enforced by | Unit | Reset |
| --- | --- | --- | --- |
| Coding-plan 1.5x | zcode.z.ai + sidecar | real token units | per z.ai plan |
| Per-API-key | RouterDone `keyPolicy` | estimated + actual tokens | daily or total |

Set the per-API-key limit lower than your 1.5x budget to self-throttle, or leave
it unlimited to use the full 1.5x quota.

## Troubleshooting

- **Test fails with "sidecar not reachable"**: confirm the sidecar process is
  running and `ZCODE_SIDECAR_URL` (or the default `127.0.0.1:3000`) is correct.
- **Test returns 403**: `ZCODE_GATEWAY_KEY` mismatch between RouterDone and the
  sidecar.
- **Chat returns 503 "no available account"**: the sidecar has no usable JWT
  account. Add one via the sidecar `/admin` UI, or wait for quota to reset.
- **Chat returns 502**: the sidecar is up but upstream zcode.z.ai rejected the
  request. Inspect the sidecar logs.
