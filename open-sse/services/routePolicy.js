import { resolveRuntimeProfileConfig } from "./runtimeProfile.js";
import {
  DIRECT_STREAM_FIRST_BYTE_TIMEOUT_MS,
  DIRECT_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS,
  DIRECT_STREAM_IDLE_AFTER_PRODUCTIVE_MS,
  DIRECT_STREAM_TOTAL_BUDGET_MS,
  COMBO_STREAM_FIRST_BYTE_TIMEOUT_MS,
  COMBO_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS,
  COMBO_REASONING_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS,
  COMBO_STREAM_IDLE_AFTER_PRODUCTIVE_MS,
  COMBO_STREAM_TOTAL_BUDGET_MS,
  FUSION_STREAM_FIRST_BYTE_TIMEOUT_MS,
  FUSION_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS,
  FUSION_STREAM_IDLE_AFTER_PRODUCTIVE_MS,
  FUSION_STREAM_TOTAL_BUDGET_MS,
  DEFAULT_RETRY_CONFIG,
} from "../config/runtimeConfig.js";

const MIN_MS = 1;
const IMMEDIATE_FALLBACK_STATUSES = new Set([400, 401, 402, 403, 404, 406, 408, 429]);
const TRANSIENT_RETRY_STATUSES = new Set([502, 503, 504]);

const DEFAULTS = {
  direct: {
    stream: {
      firstByteTimeoutMs: DIRECT_STREAM_FIRST_BYTE_TIMEOUT_MS,
      firstProductiveTimeoutMs: DIRECT_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS,
      idleAfterProductiveMs: DIRECT_STREAM_IDLE_AFTER_PRODUCTIVE_MS,
      totalBudgetMs: DIRECT_STREAM_TOTAL_BUDGET_MS,
    },
    retry: {
      502: DEFAULT_RETRY_CONFIG[502],
      503: DEFAULT_RETRY_CONFIG[503],
      504: DEFAULT_RETRY_CONFIG[504],
    },
  },
  combo: {
    stream: {
      firstByteTimeoutMs: COMBO_STREAM_FIRST_BYTE_TIMEOUT_MS,
      firstProductiveTimeoutMs: COMBO_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS,
      idleAfterProductiveMs: COMBO_STREAM_IDLE_AFTER_PRODUCTIVE_MS,
      totalBudgetMs: COMBO_STREAM_TOTAL_BUDGET_MS,
    },
    retry: { attempts: 0, delayMs: 1000 },
  },
  fusion: {
    stream: {
      firstByteTimeoutMs: FUSION_STREAM_FIRST_BYTE_TIMEOUT_MS,
      firstProductiveTimeoutMs: FUSION_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS,
      idleAfterProductiveMs: FUSION_STREAM_IDLE_AFTER_PRODUCTIVE_MS,
      totalBudgetMs: FUSION_STREAM_TOTAL_BUDGET_MS,
    },
    retry: { attempts: 0, delayMs: 0 },
  },
};

function toMs(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.max(MIN_MS, parsed) : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function isImmediateFallbackStatus(status) {
  return IMMEDIATE_FALLBACK_STATUSES.has(Number(status));
}

export function isRetryableTransientStatus(status) {
  return TRANSIENT_RETRY_STATUSES.has(Number(status));
}

export function adaptiveFirstProductiveTimeoutMs(routeMode, fallbackMs, stats = null) {
  // Clamp even without stats so saved per-combo overrides cannot inflate the
  // attempt deadline above what the route mode actually tolerates. The combo
  // ceiling must accommodate the reasoning cap: a reasoning model with no
  // fallback is deliberately given COMBO_REASONING_STREAM_FIRST_PRODUCTIVE_
  // TIMEOUT_MS by withModelStreamPolicy, and a 12s cap here would silently
  // shrink it back — the root cause of grok-4.5 "Upstream headers timeout"
  // aborts on large-context (Claude Code) requests that need >15s to prefill.
  const comboMax = Math.max(12000, COMBO_REASONING_STREAM_FIRST_PRODUCTIVE_TIMEOUT_MS);
  const bounds = routeMode === "combo"
    ? { min: 4000, max: comboMax }
    : routeMode === "fusion"
      ? { min: 3000, max: 8000 }
      : { min: 5000, max: fallbackMs };
  if (!stats || !Number.isFinite(stats.p90TtftMs)) return clamp(fallbackMs, bounds.min, bounds.max);
  return clamp(Math.round(stats.p90TtftMs * 1.8 + 1500), bounds.min, bounds.max);
}

export function resolveRoutePolicy(routeMode = "direct", overrides = {}) {
  const key = DEFAULTS[routeMode] ? routeMode : "direct";
  const base = DEFAULTS[key];
  const profile = resolveRuntimeProfileConfig(overrides.providerSpecificData);
  const profileStream = profile.stream || {};
  const streamOverrides = overrides.stream || {};
  const legacyFirstProductive = overrides.streamPreflightTimeoutMs ?? overrides.preflightTimeoutMs;
  const firstProductiveDefault = legacyFirstProductive ?? streamOverrides.firstProductiveTimeoutMs ?? base.stream.firstProductiveTimeoutMs;
  const stream = {
    firstByteTimeoutMs: toMs(streamOverrides.firstByteTimeoutMs, profileStream.firstByteTimeoutMs ?? base.stream.firstByteTimeoutMs),
    firstProductiveTimeoutMs: adaptiveFirstProductiveTimeoutMs(key, toMs(firstProductiveDefault, profileStream.firstProductiveTimeoutMs ?? base.stream.firstProductiveTimeoutMs), overrides.ttftStats),
    idleAfterProductiveMs: toMs(streamOverrides.idleAfterProductiveMs, profileStream.idleAfterProductiveMs ?? base.stream.idleAfterProductiveMs),
    totalBudgetMs: toMs(streamOverrides.totalBudgetMs, base.stream.totalBudgetMs),
  };

  const retry = { ...(base.retry || {}) };
  if (overrides.retryAttempts != null) retry.attempts = Math.max(0, Math.min(Number.parseInt(overrides.retryAttempts, 10) || 0, 10));
  if (overrides.retryDelayMs != null) retry.delayMs = Math.max(0, Math.min(Number.parseInt(overrides.retryDelayMs, 10) || 0, 30000));

  return { routeMode: key, stream, retry, heartbeat: profile.heartbeat || { enabled: false } };
}
