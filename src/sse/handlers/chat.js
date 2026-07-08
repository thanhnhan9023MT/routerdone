import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettings, getApiKeyByRawKey } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { checkModelAllowed, checkKeyQuota } from "../services/keyPolicy.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { resolveRoutePolicy } from "open-sse/services/routePolicy.js";

const MODEL_REDIRECTS = new Map([
  ["gpt-5.4-mini", "helper.fallback"],
]);

function resolveModelRedirect(modelStr, settings) {
  const settingsRedirects = settings?.modelRedirects;
  if (settingsRedirects && typeof settingsRedirects === "object") {
    const override = settingsRedirects[modelStr];
    if (typeof override === "string" && override.trim()) return override.trim();
  }
  return MODEL_REDIRECTS.get(modelStr) || null;
}
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  // Log request endpoint and model
  const url = new URL(request.url);
  let modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings. Also load the full key record
  // (when a key is present) so the per-key model-restriction and quota
  // policies below have everything they need in one DB hit.
  const settings = await getSettings();
  let keyRecord = null;
  if (apiKey) {
    keyRecord = await getApiKeyByRawKey(apiKey).catch(() => null);
  }
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = keyRecord && keyRecord.isActive;
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // Redirect client-side helper/mini models to the configured combo fallback.
  // This keeps Codex/CLI helper requests off providers that do not exist in this deployment.
  const redirectedModel = resolveModelRedirect(modelStr, settings);
  if (redirectedModel && redirectedModel !== modelStr) {
    log.info("CHAT", `Redirecting model ${modelStr} -> ${redirectedModel}`);
    modelStr = redirectedModel;
    body = { ...body, model: redirectedModel };
  }

  // Per-API-key policy gate (resale / donate quota). modelStr is now the
  // post-redirect effective requested name — the right value to match a
  // "specific model" or "specific combo" restriction against.
  if (keyRecord) {
    const modelDecision = await checkModelAllowed(modelStr, keyRecord);
    if (!modelDecision.allowed) {
      log.warn("KEY-POLICY", `Model "${modelStr}" denied for key ${log.maskKey(apiKey)}: ${modelDecision.detail}`);
      return new Response(JSON.stringify({
        error: {
          message: modelDecision.detail || "This API key is not allowed to use the requested model.",
          type: "permission_denied",
          code: modelDecision.reason || "model_not_allowed",
        },
      }), { status: HTTP_STATUS.FORBIDDEN, headers: { "Content-Type": "application/json" } });
    }

    const quotaDecision = checkKeyQuota(keyRecord, { body, modelStr });
    if (!quotaDecision.allowed) {
      const resetTxt = quotaDecision.resetAt ? ` Resets at ${new Date(quotaDecision.resetAt).toISOString()}.` : "";
      const msg = `You exceeded your current API key token quota (used ${quotaDecision.used} of ${quotaDecision.limit} tokens, this request needs ~${quotaDecision.estimatedInput} more).${resetTxt}`;
      log.warn("KEY-POLICY", `Quota denied for key ${log.maskKey(apiKey)}: used=${quotaDecision.used} limit=${quotaDecision.limit} estInput=${quotaDecision.estimatedInput}`);
      return new Response(JSON.stringify({
        error: {
          message: msg,
          type: "insufficient_quota",
          code: quotaDecision.reason || "quota_exceeded",
          used: quotaDecision.used,
          limit: quotaDecision.limit,
          estimated_input: quotaDecision.estimatedInput,
          ...(quotaDecision.resetAt ? { reset_at: quotaDecision.resetAt } : {}),
        },
      }), { status: HTTP_STATUS.RATE_LIMITED, headers: { "Content-Type": "application/json" } });
    }
  }

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const comboRetryAttempts = comboStrategies[modelStr]?.retryAttempts;
    const comboRetryDelayMs = comboStrategies[modelStr]?.retryDelayMs;
    const comboPolicy = resolveRoutePolicy(comboStrategy === "fusion" ? "fusion" : "combo", {
      retryAttempts: comboStrategies[modelStr]?.retryAttempts,
      retryDelayMs: comboStrategies[modelStr]?.retryDelayMs,
      streamPreflightTimeoutMs: comboStrategies[modelStr]?.preflightTimeoutMs,
    });
    const comboPreflightTimeoutMs = comboPolicy.stream.firstProductiveTimeoutMs;

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, attemptContext = {}) => {
          let cleanRawReq = clientRawRequest;
          if (attemptContext.isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, attemptContext);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m, attemptContext) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, attemptContext),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      comboRetryAttempts,
      comboRetryDelayMs,
      comboPreflightTimeoutMs
    });
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, { requestedModel: modelStr, attemptModel: modelStr, attemptIndex: 1, attemptTotal: 1 });
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, attemptContext = {}) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const comboRetryAttempts = comboStrategies[modelStr]?.retryAttempts;
      const comboRetryDelayMs = comboStrategies[modelStr]?.retryDelayMs;
      const comboPolicy = resolveRoutePolicy(comboStrategy === "fusion" ? "fusion" : "combo", {
        retryAttempts: comboStrategies[modelStr]?.retryAttempts,
        retryDelayMs: comboStrategies[modelStr]?.retryDelayMs,
        streamPreflightTimeoutMs: comboStrategies[modelStr]?.preflightTimeoutMs,
      });
      const comboPreflightTimeoutMs = comboPolicy.stream.firstProductiveTimeoutMs;

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, nestedAttemptContext = {}) => {
            let cleanRawReq = clientRawRequest;
            if (nestedAttemptContext.isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, nestedAttemptContext);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, nestedAttemptContext) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, nestedAttemptContext),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        comboRetryAttempts,
        comboRetryDelayMs,
        comboPreflightTimeoutMs
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Log model routing (alias → actual model)
  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  const routeMode = attemptContext.routeMode || (attemptContext.comboName ? "combo" : "direct");
  const ignoreModelLocks = routeMode === "combo" || routeMode === "fusion";

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { ignoreModelLocks });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, {
          code: "all_accounts_locked",
          comboCooldownReason: "auth_model_locked",
        });
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Log account selection
    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const routeInfo = {
      requestedModel: attemptContext.requestedModel || body.model || modelStr,
      comboName: attemptContext.comboName || null,
      comboRunId: attemptContext.comboRunId || null,
      attemptModel: attemptContext.attemptModel || modelStr,
      attemptIndex: attemptContext.attemptIndex || 1,
      attemptTotal: attemptContext.attemptTotal || 1,
      routeMode,
      fusionRole: attemptContext.fusionRole || null,
      actualProvider: provider,
      actualModel: model,
    };
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      contextGuardEnabled: chatSettings.contextGuardEnabled !== false,
      contextGuardMaxBytes: chatSettings.contextGuardMaxBytes,
      contextGuardKeepRecent: chatSettings.contextGuardKeepRecent,
      contextGuardHardCapTokens: chatSettings.contextGuardHardCapTokens,
      providerThinking,
      routeInfo,
      streamTimeoutPolicy: resolveRoutePolicy(routeMode, { stream: attemptContext.streamTimeoutPolicy, streamPreflightTimeoutMs: attemptContext.streamPreflightTimeoutMs }).stream,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) return result.response;

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
