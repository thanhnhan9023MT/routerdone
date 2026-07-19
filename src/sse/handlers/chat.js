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
import { classifyModelRoute, isAutoRouteFailure } from "open-sse/services/modelRouting.js";
import { checkModelAllowed, checkKeyQuota } from "../services/keyPolicy.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { resolveRoutePolicy } from "open-sse/services/routePolicy.js";
import { detectContextBackupFormat, isContextBackupEligible, normalizeContextBackupConfig } from "../services/contextSummaryBackup.js";

function estimateBackupTokens(body, format) {
  const source = format === "responses" ? body?.input : body?.messages;
  return Math.ceil(JSON.stringify(source || []).length / 4);
}

async function applyContextSummaryBackup(body, settings, request) {
  let config;
  try { config = normalizeContextBackupConfig(settings?.routerDoneContextBackup); } catch { return body; }
  if (!config.enabled || request.headers.get("x-routerdone-context-compact") === "1") return body;
  const pathname = new URL(request.url).pathname;
  const format = detectContextBackupFormat(body, pathname);
  if (!format || !isContextBackupEligible(body, { format })) return body;
  const estimatedTokens = estimateBackupTokens(body, format);
  if (estimatedTokens < config.thresholdTokens) return body;

  const key = format === "responses" ? "input" : "messages";
  const keep = Math.max(1, config.retainRecentTurns) * 2;
  const items = body[key];
  const older = items.slice(0, -keep);
  const recent = items.slice(-keep);
  const lines = older.map((item) => `${item.role}: ${JSON.stringify(item.content)}`).join("\n");
  let summaryText = "";
  const compactModels = [config.compressModel, config.compressFallbackModel].filter((model, index, list) => model && list.indexOf(model) === index);
  for (const compactModel of compactModels) {
    if (summaryText) break;
    try {
      const compactRequest = new Request(new URL("/v1/chat/completions", request.url), {
        method: "POST",
        headers: new Headers({ "content-type": "application/json", "authorization": request.headers.get("authorization") || "", "x-routerdone-context-compact": "1" }),
        body: JSON.stringify({ model: compactModel, stream: false, messages: [
          { role: "system", content: "Summarize the older conversation faithfully. Preserve decisions, requirements, identifiers, errors, and unfinished work. Output only the compact summary." },
          { role: "user", content: lines },
        ] }),
      });
      const compactResponse = await handleChat(compactRequest);
      const compactJson = await compactResponse.json();
      summaryText = compactJson?.choices?.[0]?.message?.content || compactJson?.output_text || "";
      if (summaryText) log.info("CONTEXT-BACKUP", `model=${compactModel} applied`);
    } catch (error) {
      log.warn("CONTEXT-BACKUP", `model ${compactModel} failed; trying fallback: ${error.message}`);
    }
  }  if (!summaryText) summaryText = `[RouterDone Context Summary Backup]\n${older.map((item) => `${item.role}: ${textOnlyForBackup(item.content)}`).join("\n")}`;
  const summaryItem = format === "responses"
    ? { type: "message", role: "system", content: [{ type: "input_text", text: summaryText }] }
    : { role: "system", content: summaryText };
  log.info("CONTEXT-BACKUP", `applied format=${format} estimatedTokens=${estimatedTokens} model=${config.compressModel || config.compressFallbackModel || "local"}`);
  return { ...body, [key]: [summaryItem, ...recent] };
}

function textOnlyForBackup(value) {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map((part) => part?.text || "").join(" ").replace(/\s+/g, " ").trim();
  return "";
}
function maybeBackupBody(body, settings, request) {
  return applyContextSummaryBackup(body, settings, request);
}

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
  body = await maybeBackupBody(body, settings, request);
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
      comboOutputModel: comboModels.outputModel,
      comboStripReasoning: comboModels.stripReasoning,
      comboMaskIdentity: comboModels.maskIdentity,
      handleSingleModel: (b, m, attemptContext) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, attemptContext),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      comboRetryAttempts,
      comboRetryDelayMs,
      comboPreflightTimeoutMs,
      comboReasoningTimeoutMs: comboModels.reasoningTimeoutMs || null,
      nodeTimeouts: comboModels.nodeTimeouts || null,
      comboVisionModel: comboModels.visionModel || null,
      comboPdfModel: comboModels.pdfModel || null
    });
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, { requestedModel: modelStr, attemptModel: modelStr, attemptIndex: 1, attemptTotal: 1 });
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, attemptContext = {}) {
  // Auto routing is opt-in; explicit model/combo requests bypass classification unchanged.
  const route = classifyModelRoute(modelStr, {
    auto: attemptContext.autoRoute === true,
    body,
    localModel: attemptContext.localModel,
    strongModel: attemptContext.strongModel,
    explicitModel: modelStr !== "auto" ? modelStr : "",
  });
  const selectedModel = route.model || modelStr;
  const modelInfo = await getModelInfo(selectedModel);

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
        comboOutputModel: comboModels.outputModel,
        comboStripReasoning: comboModels.stripReasoning,
        comboMaskIdentity: comboModels.maskIdentity,
        handleSingleModel: (b, m, nestedAttemptContext) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, nestedAttemptContext),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        comboRetryAttempts,
        comboRetryDelayMs,
        comboPreflightTimeoutMs,
        comboReasoningTimeoutMs: comboModels.reasoningTimeoutMs || null,
        nodeTimeouts: comboModels.nodeTimeouts || null,
      comboVisionModel: comboModels.visionModel || null,
      comboPdfModel: comboModels.pdfModel || null
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
      headroomCompressModel: chatSettings.headroomCompressModel || "",
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomAdaptive: chatSettings.headroomAdaptive,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      contextGuardEnabled: chatSettings.contextGuardEnabled !== false,
      contextGuardMaxBytes: chatSettings.contextGuardMaxBytes,
      contextGuardKeepRecent: chatSettings.contextGuardKeepRecent,
      contextGuardHardCapTokens: chatSettings.contextGuardHardCapTokens,
      responsesCompactionEnabled: chatSettings.responsesCompactionEnabled === true,
      responsesCompactionThresholdTokens: chatSettings.responsesCompactionThresholdTokens,
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

    // Local auto-route failure → one-way strong fallback; never downgrade strong → local.
    if (route.mode === "local" && route.fallbackModel && isAutoRouteFailure(result.status)) {
      log.warn("ROUTING", `Local route failed (${result.status}), falling back to ${route.fallbackModel}`);
      return handleSingleModelChat(
        { ...body, model: route.fallbackModel },
        route.fallbackModel,
        clientRawRequest,
        request,
        apiKey,
        { ...attemptContext, autoRoute: false, localModel: null, strongModel: null }
      );
    }

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
