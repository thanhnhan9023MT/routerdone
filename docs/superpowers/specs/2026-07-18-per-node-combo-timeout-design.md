# Per-node combo timeout — design

**Goal:** let an operator set a timeout individually for each model (node) inside a
routerdone combo, plus a UI in the dashboard combo editor. Today the stream timeout
is only global (env) or per-combo (`reasoningTimeoutMs`).

**Scope (agreed):** ONE timeout value per node (seconds). It overrides that node's
`firstByteTimeoutMs` AND `firstProductiveTimeoutMs`. Blank = combo/global default.

## Key review findings (validated against code)
- Combo runner lives in the LOCAL package `open-sse/services/combo.js` (editable).
- Per-node seam already exists: `withModelStreamPolicy(policy, body, modelStr, reasoningTimeoutMs)`
  called at `combo.js:876` with the current node's `modelStr`.
- BUG-1: `withModelStreamPolicy` returns early unless `isSlowReasoningAttempt(...)` — so
  today the override is silently ignored for NON-reasoning models. Explicit per-node
  timeout must BYPASS that gate.
- BUG-2: it only overrides `firstProductiveTimeoutMs`; we must also set `firstByteTimeoutMs`.
- BUG-3: effective max is 300 s (resolveRoutePolicy combo bound `[4000, 300000]`). Validate 1–300 s.

## Components
1. **DB** (`src/lib/db/schema.js` + `migrate.js`): add nullable column `nodeTimeouts TEXT`
   to `combos` (JSON map `{ "<node-ref>": <ms> }`). Existing rows = NULL → default.
2. **Repo** (`src/lib/db/repos/combosRepo.js`): read/parse + write/stringify `nodeTimeouts`;
   `normalizeNodeTimeouts` validates each value to an int in `[1000, 300000]` ms (drops
   invalid/blank), keeps only keys present in `models`.
3. **API** (`src/app/api/combos/route.js` + `[id]/route.js`): accept + persist `nodeTimeouts`.
4. **Runner** (`open-sse/services/combo.js`): thread `nodeTimeouts` into `handleComboChat`;
   at the seam resolve `perNode = nodeTimeouts?.[modelStr]`; extend `withModelStreamPolicy`
   to take `perNodeTimeoutMs` — when set, override BOTH firstByte+firstProductive and bypass
   the reasoning gate. Also pass `nodeTimeouts` from `chat.js` handler.
5. **UI** (`src/shared/components/ComboFormModal.js`): a small "timeout (s)" number input on
   each model row, optional, wired to a `nodeTimeouts` form-state map; submit converts s→ms.

## Data flow / compat / test
UI (s) → API (×1000 ms) → `nodeTimeouts` col. Runner: `combo.nodeTimeouts[node]` → node policy.
Backward-compatible (new nullable col; `models` unchanged). Test: repo round-trip + runner
picks per-node timeout + non-reasoning model honored; manual UI. Deploy: routerdone blue/green.
