import { detectFormat, getTargetFormat, resolveTransport } from "../services/provider.js";
import { normalizeLmstudioMessages } from "../services/runtimeProfile.js";
import { translateRequest } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { normalizeClaudePassthrough } from "../translator/formats/claude.js";
import { COLORS } from "../utils/stream.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelStrip, getModelUpstreamId, getModelType, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { PROVIDERS } from "../config/providers.js";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, shouldForceStreamUpstream } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { resolveRoutePolicy } from "../services/routePolicy.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { buildRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { injectCaveman } from "../rtk/caveman.js";
import { injectPonytail } from "../rtk/ponytail.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { guardContext, formatContextGuardLog, estimateInputTokens, pruneContextToHardCap, formatHardCapPruneLog } from "../rtk/contextGuard.js";
import { compressWithHeadroom, formatHeadroomSizeLog, isHeadroomPhantomSavings, resolveHeadroomDecision } from "../rtk/headroom.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { stripUnsupportedModalities } from "../translator/concerns/modality.js";
import { prefetchRemoteImages } from "../translator/concerns/prefetch.js";

const DEFAULT_CONTEXT_GUARD_SOFT_TOKENS = Math.max(1, Number(process.env.CONTEXT_GUARD_SOFT_TOKENS) || 60000);
const DEFAULT_CONTEXT_GUARD_KEEP_RECENT = Math.max(1, Number(process.env.CONTEXT_GUARD_KEEP_RECENT) || 3);

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
export async function handleChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, headroomEnabled, headroomUrl, headroomCompressModel, headroomCompressUserMessages, headroomAdaptive, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel, contextGuardEnabled, contextGuardMaxBytes, contextGuardKeepRecent, contextGuardHardCapTokens, responsesCompactionEnabled, responsesCompactionThresholdTokens, sourceFormatOverride, providerThinking, routeInfo = null, streamTimeoutPolicy = null, streamPreflightTimeoutMs = null }) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();
  const routeMode = routeInfo?.routeMode || (routeInfo?.comboName ? "combo" : "direct");
  const resolvedStreamPolicy = resolveRoutePolicy(routeMode, { stream: streamTimeoutPolicy, streamPreflightTimeoutMs, providerSpecificData: credentials?.providerSpecificData }).stream;
  const headersDeadlineMs = routeMode === "direct"
    ? null
    : (resolvedStreamPolicy.firstByteTimeoutMs || 3000) + (resolvedStreamPolicy.firstProductiveTimeoutMs || 8000);

  body = normalizeLmstudioMessages(body, credentials?.providerSpecificData);
  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  // Multi-endpoint providers: pick transport matching sourceFormat → zero translation
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  const targetFormat = modelTargetFormat || runtimeTransport?.format || getTargetFormat(provider, credentials);
  if (runtimeTransport && credentials) credentials.runtimeTransport = runtimeTransport;
  const stripList = getModelStrip(alias, model);
  const upstreamModel = getModelUpstreamId(alias, model);

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  if (providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming =
  PROVIDERS[provider]?.forceStream === true
  || shouldForceStreamUpstream(provider, model);
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // Image generation models require non-streaming (Google v1internal:generateContent)
  const modelType = getModelType(alias, model);
  const isImageGenModel = modelType === "imageGen" || /image|imagen|image-generation/i.test(model);
  if (isImageGenModel && (provider === "antigravity" || provider === "gemini-cli")) {
    stream = false;
  }

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true && !providerRequiresStreaming) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model);
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);
  // Native OpenAI Responses compaction; provider returns opaque compaction items.
  if (sourceFormat === FORMATS.OPENAI_RESPONSES && responsesCompactionEnabled === true && !body.context_management ) {
    const threshold = Number(responsesCompactionThresholdTokens);
    if (Number.isSafeInteger(threshold) && threshold >= 1) {
      body = { ...body, context_management: [{ type: "compaction", compact_threshold: threshold }] };
    }
  }

  // Expose raw client headers to translators/executors for session-id resolution
  if (credentials) credentials.rawHeaders = clientRawRequest?.headers || {};

  // Validate/strip media before dispatch, including native passthrough. Translation
  // may be skipped, but malformed client media must never bypass the boundary.
  {
    const caps = getCapabilitiesForModel(provider, model);
    if (stripUnsupportedModalities(body, sourceFormat, caps)) {
      log?.debug?.("MODALITY", `stripped unsupported media for ${provider}/${model}`);
    }
    // Remote prefetch remains disabled for native passthrough to preserve native semantics.
    if (!passthrough) {
      try {
        const n = await prefetchRemoteImages(body, sourceFormat, targetFormat, { signal: undefined });
        if (n > 0) log?.debug?.("MODALITY", `prefetched ${n} remote image(s) for ${targetFormat}`);
      } catch (e) { log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`); }
    }
  }

  let translatedBody;
  let toolNameMap;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model: upstreamModel };
    // Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
    if (clientTool === "claude") normalizeClaudePassthrough(translatedBody, upstreamModel);
  } else {
    translatedBody = translateRequest(sourceFormat, targetFormat, upstreamModel, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
    if (!translatedBody) {
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    translatedBody.model = upstreamModel;
  }
  if (translatedBody && typeof translatedBody === "object") {
    translatedBody.stream = stream;
  }

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  if (clientTool === "claude" && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // Final image boundary after translation: translators can create a malformed
  // target image shape even when the source request was valid.
  const finalCaps = getCapabilitiesForModel(provider, model);
  if (stripUnsupportedModalities(translatedBody, finalFormat, finalCaps)) {
    log?.debug?.("MODALITY", `validated final media shape for ${provider}/${model}`);
  }

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(msg => msg.role !== "tool");
    delete translatedBody.tools;
  }

  // RTK: compress tool_result content
  const rtkStats = compressMessages(translatedBody, rtkEnabled);
  const rtkLine = formatRtkLog(rtkStats);
  if (rtkLine) console.log(rtkLine);

  // Context guard: evict old reasoning encrypted_content blobs before the
  // request reaches the model hard cap. User settings can lower the threshold,
  // but should not raise it above the selected model's safe input window.
  const isCompact = !!body._compact;
  const modelCtxWindow = getCapabilitiesForModel(provider, upstreamModel).contextWindow || 200000;
  const hardCapTokens = contextGuardHardCapTokens > 0 ? contextGuardHardCapTokens : Math.floor(modelCtxWindow * 0.85);
  const modelGuardMaxBytes = Math.max(1, hardCapTokens * 4);
  const softGuardMaxBytes = Math.max(1, Math.min(DEFAULT_CONTEXT_GUARD_SOFT_TOKENS, hardCapTokens) * 4);
  const effectiveContextGuardMaxBytes = contextGuardMaxBytes > 0
    ? Math.min(contextGuardMaxBytes, modelGuardMaxBytes, softGuardMaxBytes)
    : Math.min(modelGuardMaxBytes, softGuardMaxBytes);
  const effectiveContextGuardKeepRecent = contextGuardKeepRecent > 0
    ? Math.min(contextGuardKeepRecent, DEFAULT_CONTEXT_GUARD_KEEP_RECENT)
    : DEFAULT_CONTEXT_GUARD_KEEP_RECENT;
  const ctxGuardStats = guardContext(translatedBody, {
    enabled: contextGuardEnabled !== false,
    maxBytes: effectiveContextGuardMaxBytes,
    keepRecent: effectiveContextGuardKeepRecent,
    isCompact,
  });
  const ctxGuardLine = formatContextGuardLog(ctxGuardStats);
  if (ctxGuardLine) console.log(ctxGuardLine);

  // Headroom: adaptive external compression; small requests bypass the extra network hop.
  const headroomDiagnostics = {};
  const headroomDecision = resolveHeadroomDecision({
    estimatedTokens: estimateInputTokens(translatedBody, upstreamModel),
    hardCapTokens,
    config: { ...(headroomAdaptive || {}), enabled: headroomEnabled && headroomAdaptive?.enabled !== false },
    isCompact,
  });
  headroomDiagnostics.decision = headroomDecision.mode;
  headroomDiagnostics.ratioPercent = Math.round(headroomDecision.ratioPercent * 10) / 10;
  const headroomStats = headroomDecision.mode === "bypass"
    ? null
    : await compressWithHeadroom(translatedBody, { enabled: true, url: headroomUrl, model: headroomCompressModel?.trim() || upstreamModel, format: finalFormat, compressUserMessages: headroomCompressUserMessages, timeoutMs: headroomDecision.timeoutMs, diagnostics: headroomDiagnostics });
  const headroomLine = formatHeadroomSizeLog(headroomStats, headroomDiagnostics);
  if (headroomLine) log?.info?.("HEADROOM", headroomLine);
  if (headroomDecision.mode === "bypass") {
    log?.debug?.("HEADROOM", `bypassed: ${headroomDecision.reason} | ratio=${headroomDiagnostics.ratioPercent}%`);
  } else if (!headroomStats && headroomEnabled && headroomDiagnostics.reason) {
    log?.warn?.("HEADROOM", `fallback: ${headroomDiagnostics.reason} | mode=${headroomDecision.mode}`);
  }
  if (isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)) {
    log?.warn?.("HEADROOM", "reported token delta, but outbound JSON shrank <5%; provider may bill near-original payload");
  }

  // Input size verification: estimate input tokens after all token savers.
  // Logs per-request input size for monitoring and enforces a hard cap that
  // signals compact when the conversation exceeds the model context window.
  // Fast path: skip the exact js-tiktoken pass when the payload is comfortably under
  // the hard cap. byte/3 OVER-estimates tokens (English ~4 char/tok, code ~3) and the
  // 0.7 margin absorbs estimator error, so a request flagged "under" is genuinely under
  // — the context guard would never prune/reject it, and exact tokenization (~50ms on
  // large bodies) would just burn CPU. Only tokenize precisely near the cap.
  // estInputTokens feeds ONLY the context guard (prune/reject over-large ctx), NEVER
  // billing (billing uses the provider's real usage) — so this cannot change any bill.
  let estInputTokens;
  const approxInputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(translatedBody), "utf8") / 3);
  if (isCompact || approxInputTokens < hardCapTokens * 0.7) {
    estInputTokens = approxInputTokens;
  } else {
    estInputTokens = estimateInputTokens(translatedBody, upstreamModel);
    if (estInputTokens > hardCapTokens && !isCompact) {
      const pruneStats = pruneContextToHardCap(translatedBody, {
        enabled: contextGuardEnabled !== false,
        hardCapTokens,
        keepRecent: effectiveContextGuardKeepRecent,
        isCompact,
        model: upstreamModel,
      });
      const pruneLine = formatHardCapPruneLog(pruneStats);
      if (pruneLine) console.log(pruneLine);
      estInputTokens = estimateInputTokens(translatedBody, upstreamModel);
    }
  }
  console.log(`[CTX-GUARD] input ~${estInputTokens} tokens | cap ${hardCapTokens} (ctx ${modelCtxWindow})${isCompact ? " | compact" : ""}`);
  if (estInputTokens > hardCapTokens && !isCompact) {
    log?.warn?.("CTX-GUARD", `input ${estInputTokens} tokens exceeds hard cap ${hardCapTokens} after pruning`);
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `context_too_large: estimated ${estInputTokens} input tokens exceed the ${hardCapTokens} hard cap for ${upstreamModel}. Reduce conversation context (run /compact) before continuing.`);
  }

  // Caveman: inject terse-style system prompt
  if (cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    log?.debug?.("CAVEMAN", `${cavemanLevel} | ${finalFormat}`);
  }

  // Ponytail: inject lazy-senior-dev system prompt
  if (ponytailEnabled && ponytailLevel) {
    injectPonytail(translatedBody, finalFormat, ponytailLevel);
    log?.debug?.("PONYTAIL", `${ponytailLevel} | ${finalFormat}`);
  }

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(model, provider, connectionId, false);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(model, provider, connectionId, false),
    log, provider, model
  });

  const proxyOptions = {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
  };

  if (proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody;
  let headersTimer = null;
  let upstreamHeadersTimedOut = false;
  if (headersDeadlineMs) {
    headersTimer = setTimeout(() => {
      upstreamHeadersTimedOut = true;
      log?.warn?.("STREAM", `${provider?.toUpperCase?.() || provider} | ${model} | upstream headers timeout (${headersDeadlineMs}ms)`);
      try { streamController.abort(); } catch {}
    }, headersDeadlineMs);
  }
  try {
    const result = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions, requestContext: { isCompact, disableInternalRetries: routeMode === "combo" || routeMode === "fusion" } });
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
    if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
  } catch (error) {
    if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
    trackPendingRequest(model, provider, connectionId, false, true);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${error.name === "AbortError" ? 499 : HTTP_STATUS.BAD_GATEWAY}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, apiKey, routeInfo,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: translatedBody || null,
      response: { error: error.message || String(error), status: error.name === "AbortError" ? 499 : 502, thinking: null },
      status: "error"
    })).catch(() => { });

    if (error.name === "AbortError") {
      streamController.handleError(error);
      if (upstreamHeadersTimedOut) return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Upstream headers timeout");
      return createErrorResult(499, "Request aborted");
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      const newCredentials = await refreshWithRetry(() => executor.refreshCredentials(credentials, log), 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions, requestContext: { isCompact, disableInternalRetries: routeMode === "combo" || routeMode === "fusion" } });
          if (retryResult.response.ok) { providerResponse = retryResult.response; providerUrl = retryResult.url; }
        } catch { log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`); }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true);
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse, executor);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, apiKey, routeInfo,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      response: { error: message, status: statusCode, thinking: null },
      status: "error"
    })).catch(() => { });

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    return createErrorResult(statusCode, errMsg, resetsAtMs);
  }

  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, routeInfo };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  const trackDone = () => trackPendingRequest(model, provider, connectionId, false);

  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, trackDone, appendLog });
    if (result) { streamController.handleComplete(); return result; }
  }

  // True non-streaming response
  if (!stream) {
    const result = await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, reqLogger, toolNameMap, trackDone, appendLog });
    streamController.handleComplete();
    return result;
  }

  // Streaming response
  const { onStreamComplete } = buildOnStreamComplete({ ...sharedCtx });
  // Provider force-stream but client non-stream -> cap first productive timeout to detect mismatch fast
  const streamTimeoutOverride = providerRequiresStreaming && !clientRequestedStreaming
    ? { ...resolvedStreamPolicy, firstProductiveTimeoutMs: Math.min(resolvedStreamPolicy.firstProductiveTimeoutMs ?? 120000, 300000) }
    : resolvedStreamPolicy;

  const retryEmptyStream = async () => {
    const retryResult = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions, requestContext: { isCompact, disableInternalRetries: routeMode === "combo" || routeMode === "fusion" } });
    reqLogger.logTargetRequest(retryResult.url, retryResult.headers, retryResult.transformedBody);
    if (retryResult.transformedBody) finalBody = retryResult.transformedBody;
    return retryResult;
  };

  return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, streamController, onStreamComplete, log, streamTimeoutPolicy: streamTimeoutOverride, retryFn: retryEmptyStream });
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
