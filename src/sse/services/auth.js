import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isClientPayloadError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil, isBusyConcurrencyError, isPreflightTimeoutError, shouldLockConnectionForError, resolveConnectionCooldownMs, buildModelFailureBackoffUpdate, buildClearModelFailureUpdate, isRateLimitError, isProviderSelfHealError, shouldDisableConnectionForError, normalizeStaleConnectionState } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS_DEFAULT, BUSY_CONNECTION_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { acquire as acquireConnectionSlot, hasCapacity as connectionHasCapacity } from "open-sse/services/connectionConcurrency.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";

const CONSOLE_TIME_ZONE = "Asia/Ho_Chi_Minh";
const consoleTimeFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: CONSOLE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatConsoleTimeGmt7(value) {
  if (!value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${consoleTimeFormatter.format(date)} GMT+7`;
}

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const lockOptions = { ignoreModelLocks: options?.ignoreModelLocks === true };
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: override.proxyPoolId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const rawConnections = await getProviderConnections({ provider: providerId, isActive: true });
    const connections = [];
    for (const connection of rawConnections) {
      const stale = normalizeStaleConnectionState(connection);
      if (stale.needsUpdate) {
        const healed = await updateProviderConnection(connection.id, stale.update);
        connections.push(healed || connection);
      } else {
        connections.push(connection);
      }
    }
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Filter out model-locked and excluded connections
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model, lockOptions)) return false;
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model, lockOptions);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c, lockOptions);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${formatConsoleTimeGmt7(lockUntil)}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model, lockOptions));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c, lockOptions)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    // Per-connection in-flight cap. Opt-in via
    // providerStrategies[<providerId>].maxConcurrentPerConnection; unset/0 keeps this
    // inert so every other provider selects exactly as before.
    //
    // Needed because round-robin alone cannot bound concurrency: it rotates on
    // `lastUsedAt`, stamped at SELECTION and never cleared, so a credential that is
    // still streaming becomes least-recently-used again after every other one has had
    // a turn. Beyond `connections` simultaneous requests the same key carries two
    // streams and an upstream that permits one answers with a concurrency 429.
    //
    // Race-free: the capacity test and the acquire() below run in the same
    // selectionMutex critical section, so two selections cannot claim one slot.
    //
    // Gated on the CALLER opting in, because a slot that is taken and never given back
    // is worse than no cap at all. Of the seven callers of this function only
    // handlers/chat.js implements the release side; image/fetch/stt/tts/embeddings/search
    // just use the credential and return. Acquiring for them would leak a slot per
    // request, and the moment someone set maxConcurrentPerConnection on a node those
    // paths use, that credential would wedge until the 15-minute stale sweep — an
    // inexplicable outage triggered by a config change. So without opt-in the whole
    // mechanism (filter AND acquire) stays off: not enforced beats half-enforced.
    const wantsConcurrencySlot = options?.acquireConcurrencySlot === true;
    const maxPerConnection = Number(providerOverride.maxConcurrentPerConnection ?? settings.maxConcurrentPerConnection ?? 0);
    const capped = wantsConcurrencySlot && Number.isFinite(maxPerConnection) && maxPerConnection > 0;
    let selectable = availableConnections;
    if (capped) {
      selectable = availableConnections.filter((c) => connectionHasCapacity(c.id, maxPerConnection));
      if (selectable.length === 0) {
        // Genuinely saturated. Report a retryable rate-limit rather than doubling up.
        // The caller surfaces this with Retry-After; the status it picks is
        // `lastStatus || lastErrorCode || 503`, so on the first attempt the client sees
        // the 429 below, and after a failed fallback it inherits that upstream's status —
        // not necessarily 503.
        const retryAfter = new Date(Date.now() + BUSY_CONNECTION_COOLDOWN_MS).toISOString();
        const busyError = `All ${availableConnections.length} ${provider} credentials are at their ${maxPerConnection}-request concurrency cap`;
        log.warn("AUTH", `${provider} | ${busyError}`);
        return {
          allRateLimited: true,
          retryAfter,
          retryAfterHuman: formatRetryAfter(retryAfter),
          lastError: busyError,
          lastErrorCode: 429,
          // Distinguishes "the credential is busy for ~2s" from "every account is locked
          // out". Without it chat.js labels both `all_accounts_locked`, which
          // combo.js isAuthLockedComboError() turns into the FULL 30s model cooldown —
          // sidelining a perfectly healthy primary over a momentary slot contention.
          concurrencyBusy: true,
        };
      }
    }

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = selectable.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...selectable].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...selectable].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = selectable[0];
    }

    // Claim the slot before handing the credential out. Unreachable under the mutex
    // (the capacity filter above already proved there is room) but a null lease must
    // never be silently ignored, or the cap would only be advisory.
    //
    // No lease at all when uncapped: an uncapped lease would still have to be released,
    // which puts the response-body wrapper in handlers/chat.js on the hot path of every
    // provider for no benefit, and turns every non-releasing caller into a slow leak.
    const concurrencyLease = capped ? acquireConnectionSlot(connection.id, maxPerConnection) : null;
    if (capped && !concurrencyLease) {
      const retryAfter = new Date(Date.now() + BUSY_CONNECTION_COOLDOWN_MS).toISOString();
      const busyError = `${provider} credential ${connection.id?.slice(0, 8)} filled its ${maxPerConnection}-request cap during selection`;
      log.warn("AUTH", busyError);
      return {
        allRateLimited: true,
        retryAfter,
        retryAfterHuman: formatRetryAfter(retryAfter),
        lastError: busyError,
        lastErrorCode: 429,
        concurrencyBusy: true,
      };
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Slot held on this credential. The caller MUST release it when the request is
      // finished (handlers/chat.js) — for a stream that means when the body closes,
      // not when the Response object is returned.
      concurrencyLease,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;
  const now = Date.now();
  const reasonText = typeof errorText === "string" ? errorText : (errorText ? JSON.stringify(errorText) : "Provider error");
  if (isClientPayloadError(status, reasonText)) {
    log.warn('AUTH', 'payload rejected; connection remains active', { status, model });
    return { shouldFallback: true, cooldownMs: 0, clientError: true };
  }
  const busyOrConcurrency = isBusyConcurrencyError(reasonText);
  const preflightTimeout = isPreflightTimeoutError(status, reasonText);
  const lastFailureAtMs = conn?.comboPreflightFailureAt ? new Date(conn.comboPreflightFailureAt).getTime() : 0;
  const recentSameKind = lastFailureAtMs && (now - lastFailureAtMs <= 60 * 1000) && conn?.comboPreflightFailureKind === (busyOrConcurrency ? "busy" : preflightTimeout ? "preflight" : null);
  const recentFailureCount = (busyOrConcurrency || preflightTimeout) ? (recentSameKind ? (conn?.comboPreflightFailureCount || 0) + 1 : 1) : 0;

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel, selfHeal;
  if (busyOrConcurrency) {
    shouldFallback = true;
    cooldownMs = resolveConnectionCooldownMs({ status, errorText: reasonText });
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS_DEFAULT);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel, selfHeal } = checkFallbackError(status, reasonText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const lockConnection = shouldLockConnectionForError({ status, errorText: reasonText, recentFailureCount });
  if (lockConnection) {
    cooldownMs = resolveConnectionCooldownMs({ status, errorText: reasonText, cooldownMs, recentFailureCount });
  }

  // Per-model consecutive-failure exponential backoff: a model that keeps
  // dying gets blocked for base*2^(n-1), reset to base on a successful call.
  let failureCounterUpdate = {};
  if (!lockConnection && model && !preflightTimeout) {
    const isRateLimit = isRateLimitError(status, reasonText);
    const isSelfHeal = selfHeal || isProviderSelfHealError(status, reasonText);
    const backoff = buildModelFailureBackoffUpdate(conn, model, { isRateLimit, selfHeal: isSelfHeal });
    cooldownMs = Math.max(cooldownMs || 0, backoff.cooldownMs);
    failureCounterUpdate = backoff.update;
  }

  const reason = reasonText.slice(0, 100);
  const lockUpdate = buildModelLockUpdate(lockConnection ? null : model, cooldownMs);
  const failureUpdate = (busyOrConcurrency || preflightTimeout)
    ? {
        comboPreflightFailureKind: busyOrConcurrency ? "busy" : "preflight",
        comboPreflightFailureCount: recentFailureCount,
        comboPreflightFailureAt: new Date(now).toISOString(),
      }
    : {
        comboPreflightFailureKind: null,
        comboPreflightFailureCount: 0,
        comboPreflightFailureAt: null,
      };

  // Billing/credit exhaustion: auto-disable the connection so it stops being
  // selected for routing until the owner fixes payment and manually re-enables it.
  const paymentBlocked = shouldDisableConnectionForError(status, reasonText);
  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    ...failureUpdate,
    ...failureCounterUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel,
    ...(paymentBlocked ? { isActive: false } : {}),
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Reset the consecutive-failure counter for the model that just succeeded.
  // Counters for other models are preserved so their backoff keeps escalating
  // until they succeed too.
  Object.assign(clearObj, buildClearModelFailureUpdate(conn, model));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      errorCode: null,
      backoffLevel: 0,
      comboPreflightFailureKind: null,
      comboPreflightFailureCount: 0,
      comboPreflightFailureAt: null,
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
