// Per-API-key policy checks: model restriction + token quota.
// Pure-ish helpers kept out of chat.js so they are trivial to unit-test.
//
// Enforcement lives in src/sse/handlers/chat.js after the model redirect and
// before the combo/single dispatch (modelStr is the post-redirect effective
// requested name at that point). Quota counters are bumped atomically inside
// saveRequestUsage in src/lib/db/repos/usageRepo.js.

import { getComboByName } from "@/lib/db";
import { getUsageDateKeyPublic, getUsagePeriodRange } from "@/lib/db/repos/usageRepo.js";
import { countRequestTokens } from "open-sse/utils/tokenEstimate";

// allowedModels shape: { type: 'all' | 'model' | 'combo', value: string | null }
// Returns { allowed: true } or { allowed: false, reason: 'model_not_allowed', detail }
export async function checkModelAllowed(modelStr, keyRecord) {
  if (!keyRecord) return { allowed: true };
  const policy = keyRecord.allowedModels || { type: "all", value: null };
  if (!policy || policy.type === "all") return { allowed: true };

  if (policy.type === "model") {
    if (!policy.value) return { allowed: true };
    if (modelStr === policy.value) return { allowed: true };
    return {
      allowed: false,
      reason: "model_not_allowed",
      detail: `This API key is restricted to model "${policy.value}".`,
    };
  }

  if (policy.type === "combo") {
    if (!policy.value) return { allowed: true };
    // The request must target the exact combo name. Bare single-model names
    // are not allowed when the policy is "specific combo".
    if (modelStr !== policy.value) {
      return {
        allowed: false,
        reason: "model_not_allowed",
        detail: `This API key is restricted to combo "${policy.value}".`,
      };
    }
    // Defensive: confirm the configured name is still a real combo.
    const combo = await getComboByName(policy.value).catch(() => null);
    if (!combo) {
      return {
        allowed: false,
        reason: "model_not_allowed",
        detail: `Configured combo "${policy.value}" no longer exists.`,
      };
    }
    return { allowed: true };
  }

  return { allowed: true };
}

// Returns the effective "used tokens" for the key, honoring the daily rollover
// (a stale usedDailyDateKey from a previous local day reads as 0).
function effectiveUsedTokens(keyRecord) {
  if (!keyRecord) return 0;
  if (keyRecord.limitType === "total") {
    return keyRecord.usedTokens || 0;
  }
  if (keyRecord.limitType === "daily") {
    const today = getUsageDateKeyPublic();
    if (keyRecord.usedDailyDateKey && keyRecord.usedDailyDateKey === today) {
      return keyRecord.usedDailyTokens || 0;
    }
    return 0;
  }
  return 0;
}

// Pre-check: deny when the next request would push usage over the limit.
// `body` is the parsed request body (used to estimate input tokens); `modelStr`
// is the post-redirect effective model name passed to the tokenizer.
// Returns { allowed: true } | { allowed: false, reason, used, limit, estimatedInput, resetAt }.
export function checkKeyQuota(keyRecord, { body, modelStr } = {}) {
  if (!keyRecord) return { allowed: true };
  if (keyRecord.limitType !== "total" && keyRecord.limitType !== "daily") {
    return { allowed: true };
  }
  const limit = typeof keyRecord.tokenLimit === "number" ? keyRecord.tokenLimit : 0;
  if (!limit || limit <= 0) return { allowed: true };

  const used = effectiveUsedTokens(keyRecord);

  // Estimate the input-side cost of this request. Fail-open on tokenizer
  // errors (treat as 0) so we still let the request reach the upstream; the
  // actual settle will record real tokens.
  let estimatedInput = 0;
  try {
    if (body) {
      const result = countRequestTokens(body, modelStr);
      estimatedInput = (result && Number.isFinite(result.count) ? result.count : 0) || 0;
    }
  } catch {
    estimatedInput = 0;
  }

  if (used + estimatedInput > limit) {
    let resetAt = null;
    if (keyRecord.limitType === "daily") {
      // Next local midnight in the configured tz.
      try {
        resetAt = computeNextLocalMidnightIso();
      } catch {
        resetAt = null;
      }
    }
    return {
      allowed: false,
      reason: "quota_exceeded",
      used,
      limit,
      estimatedInput,
      resetAt,
    };
  }
  return { allowed: true };
}

// Internal: ISO string of the next midnight in the configured usage tz.
function computeNextLocalMidnightIso() {
  const range = getUsagePeriodRange("today");
  // today's start + 1 day = next midnight (tz-correct).
  return new Date(range.startMs + 86400000).toISOString();
}
