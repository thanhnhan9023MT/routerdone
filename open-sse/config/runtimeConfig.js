// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Parse a boolean env override ("0"/"false"/"off"/"no" = false), else default.
function envBool(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);
export const COMBO_STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("COMBO_STREAM_FIRST_CHUNK_TIMEOUT_MS", 8 * 1000);

export const DIRECT_STREAM_FIRST_BYTE_TIMEOUT_MS = envMs("DIRECT_STREAM_FIRST_BYTE_TIMEOUT_MS", 10 * 1000);
export const DIRECT_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS = envMs("DIRECT_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS", 90 * 1000);
export const DIRECT_STREAM_IDLE_AFTER_PRODUCTIVE_MS = envMs("DIRECT_STREAM_IDLE_AFTER_PRODUCTIVE_MS", 180 * 1000);
export const DIRECT_STREAM_TOTAL_BUDGET_MS = envMs("DIRECT_STREAM_TOTAL_BUDGET_MS", 360 * 1000);

export const COMBO_STREAM_FIRST_BYTE_TIMEOUT_MS = envMs("COMBO_STREAM_FIRST_BYTE_TIMEOUT_MS", 3 * 1000);
export const COMBO_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS = envMs("COMBO_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS", 9 * 1000);
export const COMBO_REASONING_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS = envMs("COMBO_REASONING_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS", 45 * 1000);
export const COMBO_STREAM_IDLE_AFTER_PRODUCTIVE_MS = envMs("COMBO_STREAM_IDLE_AFTER_PRODUCTIVE_MS", 120 * 1000);
export const COMBO_STREAM_TOTAL_BUDGET_MS = envMs("COMBO_STREAM_TOTAL_BUDGET_MS", 300 * 1000);

// Feature: combo response-model unification. When on, a combo rewrites its
// response `model` field to the primary node's model (models[0]) regardless of
// which node actually served — so a combo presents ONE stable identity (e.g. a
// claude combo keeps reporting claude even when it falls back to grok, keeping
// downstream model-name checks consistent). Env: COMBO_UNIFY_RESPONSE_MODEL=0 to disable.
export const COMBO_UNIFY_RESPONSE_MODEL = envBool("COMBO_UNIFY_RESPONSE_MODEL", true);

export const FUSION_STREAM_FIRST_BYTE_TIMEOUT_MS = envMs("FUSION_STREAM_FIRST_BYTE_TIMEOUT_MS", 3 * 1000);
export const FUSION_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS = envMs("FUSION_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS", 6 * 1000);
export const FUSION_STREAM_IDLE_AFTER_PRODUCTIVE_MS = envMs("FUSION_STREAM_IDLE_AFTER_PRODUCTIVE_MS", 60 * 1000);
export const FUSION_STREAM_TOTAL_BUDGET_MS = envMs("FUSION_STREAM_TOTAL_BUDGET_MS", 90 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
// Fallback-first policy: any error should move to the next account/combo-member
// immediately rather than retrying (and stalling on) a failing provider. 502
// also covers network / connect-timeout errors (base.js maps them to 502), so
// it's 0 to kill the ~30s-per-retry connect-timeout stalls. 503/504 keep ONE
// short retry as a small safety net for single-provider models on a transient
// server blip.
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 0, delayMs: 0 },
  503: { attempts: 1, delayMs: 1000 },
  504: { attempts: 1, delayMs: 1000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];

// Providers only stable with stream:true upstream.
// Non-stream -> 502/timeout. Gateway forces stream then converts SSE->JSON.
// Add any provider here when the same symptom appears.
export const FORCE_STREAM_UPSTREAM_PROVIDERS = new Set([
  "openai",
  "codex",
  "commandcode",
  // Add provider here when non-stream causes 502/timeout:
  // just add the provider ID to this Set.
]);

// Model-specific override (if only some models are affected, not the whole provider)
export const FORCE_STREAM_UPSTREAM_MODELS = new Set([
  // "providerId/modelId",
]);

export function shouldForceStreamUpstream(provider, model) {
  if (provider === "openai-compatible") return true;
  if (typeof provider === "string" && provider.startsWith("openai-compatible-")) return true;
  if (FORCE_STREAM_UPSTREAM_PROVIDERS.has(provider)) return true;
  if (model && FORCE_STREAM_UPSTREAM_MODELS.has(`${provider}/${model}`)) return true;
  return false;
}
// Fixed-tick preflight: poll every 3s, 2-tier caps for fast fallback
export const PREFLIGHT_TICK_MS = Number(process.env.PREFLIGHT_TICK_MS) || 3000;
export const PREFLIGHT_NO_BYTE_CAP_MS = Number(process.env.PREFLIGHT_NO_BYTE_CAP_MS) || 6000;
export const PREFLIGHT_NO_CONTENT_CAP_MS = Number(process.env.PREFLIGHT_NO_CONTENT_CAP_MS) || 9000;
