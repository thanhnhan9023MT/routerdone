import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { parseSSELine } from "../../utils/streamHelpers.js";
import { PROVIDERS } from "../../config/providers.js";
import { HTTP_STATUS, PREFLIGHT_TICK_MS, PREFLIGHT_NO_BYTE_CAP_MS, PREFLIGHT_NO_CONTENT_CAP_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { createErrorResult } from "../../utils/error.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";

const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

function hasText(value) {
  return typeof value === "string" && value.length > 0;
}

function hasNonEmptyObject(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

export function isProductiveStreamChunk(chunk, format) {
  if (!chunk || chunk.done) return false;
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  if (hasText(delta.content) || hasText(delta.reasoning_content) || hasText(delta.refusal)) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  if (choice?.message && (hasText(choice.message.content) || hasText(choice.message.reasoning_content) || hasText(choice.message.refusal))) return true;
  if (format === FORMATS.CLAUDE || chunk.type?.startsWith?.("content_block")) {
    if (hasText(chunk.delta?.text) || hasText(chunk.delta?.thinking) || hasText(chunk.delta?.partial_json)) return true;
    if (chunk.type === "content_block_start" && (chunk.content_block?.type === "tool_use" || chunk.content_block?.type === "server_tool_use")) return true;
    if (hasText(chunk.content_block?.text) || hasText(chunk.content_block?.thinking)) return true;
  }
  const parts = chunk.candidates?.[0]?.content?.parts || chunk.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.some(part => hasText(part.text) || hasNonEmptyObject(part.functionCall))) return true;
  if (format === FORMATS.OPENAI_RESPONSES || chunk.type?.startsWith?.("response.")) {
    if (hasText(chunk.delta) || hasText(chunk.text)) return true;
    if (chunk.item?.type === "function_call" || chunk.type === "response.function_call_arguments.delta") return true;
    if (chunk.type === "response.output_item.added" && chunk.item?.type === "function_call") return true;
    if (chunk.type === "response.refusal.delta" && hasText(chunk.delta)) return true;
  }
  return false;
}

export function isTerminalStreamChunk(chunk) {
  if (!chunk) return false;
  if (chunk.done) return true;
  if (chunk.choices?.[0]?.finish_reason) return true;
  if (["message_stop", "response.completed", "response.failed", "response.incomplete"].includes(chunk.type)) return true;
  if (chunk.response?.candidates?.[0]?.finishReason || chunk.candidates?.[0]?.finishReason) return true;
  return false;
}

// Detect error chunks in SSE stream ? upstream may return 200 OK but embed
// an error object in the stream body. Without this check the preflight would
// either accept the error as content or silently ignore it until timeout.
export function isErrorStreamChunk(chunk) {
  if (!chunk) return false;
  if (chunk.error) return true;
  if (chunk.type === "error") return true;
  if (chunk.choices?.[0]?.error) return true;
  if (chunk.response?.error) return true;
  return false;
}

// Extract human-readable message from an error chunk for logging/fallback.
export function extractStreamErrorMessage(chunk) {
  if (typeof chunk?.error === "string") return chunk.error;
  if (chunk?.error?.message) return chunk.error.message;
  if (chunk?.choices?.[0]?.error?.message) return chunk.choices[0].error.message;
  if (chunk?.response?.error?.message) return chunk.response.error.message;
  return "Upstream error in stream";
}

export function extractStreamErrorStatus(chunk, message) {
  const candidates = [
    chunk?.status,
    chunk?.statusCode,
    chunk?.error?.status,
    chunk?.error?.statusCode,
    chunk?.error?.code,
    chunk?.choices?.[0]?.error?.status,
    chunk?.response?.error?.status,
  ];
  for (const value of candidates) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 400 && parsed <= 599) return parsed;
  }
  const text = String(message || "").toLowerCase();
  if (text.includes("429") || text.includes("too many requests") || text.includes("rate limit") || text.includes("quota")) return HTTP_STATUS.RATE_LIMITED;
  return HTTP_STATUS.BAD_GATEWAY;
}

function replayBufferedBody(reader, bufferedChunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of bufferedChunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      controller.enqueue(value);
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); }
  });
}

async function readWithDeadline(reader, ms, reason) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), Math.max(1, ms)); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isSemanticEvent(parsed) {
  if (!parsed) return false;
  const t = parsed.type || "";
  if (["response.created", "response.in_progress", "message_start", "message_delta", "content_block_start", "content_block_delta"].includes(t)) return true;
  if (parsed.choices?.[0]?.delta?.role === "assistant") return true;
  return false;
}

function isHeartbeatChunk(line, parsed) {
  if (!line) return false;
  const s = typeof line === "string" ? line : "";
  if (s.trim().length === 0) return true;
  if (s.startsWith(":")) return true;
  if (parsed?.type === "ping") return true;
  return false;
}

export function isRetryableEmptyStreamError(error) {
  const text = String(error || "").toLowerCase();
  return text.includes("empty upstream stream") || text.includes("terminal before productive");
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

export async function guardInitialStream(providerResponse, { targetFormat, log, provider, model, policy, routeInfo }) {
  if (!providerResponse.body) return { response: providerResponse };
  const reader = providerResponse.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const startTime = Date.now();
  const timing = {
    firstByteAt: null,
    lastNonProductiveAt: null,
    acceptedAt: null,
    byteCount: 0,
  };
  const formatTiming = () => [
    routeInfo?.comboRunId ? `run=${routeInfo.comboRunId}` : null,
    `provider=${provider || "unknown"}`,
    `model=${model || "unknown"}`,
    `preflight_elapsed=${Date.now() - startTime}ms`,
    `first_byte_at=${timing.firstByteAt ? timing.firstByteAt - startTime : -1}ms`,
    `last_non_productive_at=${timing.lastNonProductiveAt ? timing.lastNonProductiveAt - startTime : -1}ms`,
    `accepted_at=${timing.acceptedAt ? timing.acceptedAt - startTime : -1}ms`,
    `bytes=${timing.byteCount}`,
  ].filter(Boolean).join(" | ");
  const logPreflight = (level, event, extra = "") => {
    const suffix = extra ? ` | ${extra}` : "";
    log?.[level]?.("PREFLIGHT", `${event} | ${formatTiming()}${suffix}`);
  };
  const firstByteTimeoutMs = policy?.firstByteTimeoutMs || PREFLIGHT_NO_BYTE_CAP_MS;
  const firstProductiveTimeoutMs = policy?.firstProductiveTimeoutMs || PREFLIGHT_NO_CONTENT_CAP_MS;
  const totalBudgetMs = policy?.totalBudgetMs || 0;
  const bufferedChunks = [];
  let buffer = "";
  let hasByte = false;
  let lastByteTime = startTime;
  let pendingRead = reader.read();
  try {
    while (true) {
      const now = Date.now();
      if (!hasByte && now - lastByteTime > firstByteTimeoutMs) {
        throw new Error(`Upstream first byte timeout (${Math.ceil(firstByteTimeoutMs / 1000)}s)`);
      }
      if (hasByte && now - lastByteTime > firstProductiveTimeoutMs) {
        throw new Error(`Upstream first productive timeout (${Math.ceil(firstProductiveTimeoutMs / 1000)}s)`);
      }
      if (totalBudgetMs > 0 && now - startTime > totalBudgetMs) {
        throw new Error(`Upstream stream total budget exceeded (${Math.ceil(totalBudgetMs / 1000)}s)`);
      }

      let timer;
      const timeoutPromise = new Promise(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), PREFLIGHT_TICK_MS);
      });
      const result = await Promise.race([
        pendingRead.then(r => ({ done: r.done, value: r.value, timedOut: false })),
        timeoutPromise,
      ]);
      clearTimeout(timer);

      if (result.timedOut) {
        // Fixed tick 3s: re-check same pendingRead; caps above handle fallback
        continue;
      }

      pendingRead = null;
      const { done, value } = result;
      let foundProductive = false;
      let foundTerminal = false;
      let foundSemantic = false;
      let foundHeartbeat = false;
      let foundError = false;
      let streamErrorMsg = null;
      let streamErrorStatus = HTTP_STATUS.BAD_GATEWAY;

      if (done) {
        if (foundProductive) {
          const body = replayBufferedBody(reader, bufferedChunks);
          return { response: new Response(body, { status: providerResponse.status, statusText: providerResponse.statusText, headers: providerResponse.headers }) };
        }
        throw new Error("Empty upstream stream (terminal before productive)");
      }

      const bytes = value ? (value.byteLength || value.length || 0) : 0;
      if (bytes > 0) {
        const byteTime = Date.now();
        if (!timing.firstByteAt) timing.firstByteAt = byteTime;
        timing.byteCount += bytes;
        lastByteTime = byteTime;
        hasByte = true;
      }
      bufferedChunks.push(value);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) { foundHeartbeat = true; continue; }
        const parsed = parseSSELine(trimmed, targetFormat) || parseSSELine(trimmed, FORMATS.OPENAI);
        if (!parsed) continue;
        if (isErrorStreamChunk(parsed)) {
          foundError = true;
          streamErrorMsg = extractStreamErrorMessage(parsed);
          streamErrorStatus = extractStreamErrorStatus(parsed, streamErrorMsg);
          break;
        }
        if (isProductiveStreamChunk(parsed, targetFormat)) { foundProductive = true; break; }
        if (isTerminalStreamChunk(parsed)) { foundTerminal = true; break; }
        if (isSemanticEvent(parsed)) { foundSemantic = true; }
        else if (isHeartbeatChunk(trimmed, parsed)) { foundHeartbeat = true; }
      }

      if (foundError) {
        await reader.cancel().catch(() => {});
        logPreflight("warn", "failed", `reason=error_chunk: ${JSON.stringify(streamErrorMsg)}`);
        return { error: `Upstream stream error: ${streamErrorMsg}`, status: streamErrorStatus };
      }

      if (foundProductive) {
        timing.acceptedAt = Date.now();
        logPreflight("info", "accepted");
        const body = replayBufferedBody(reader, bufferedChunks);
        return { response: new Response(body, { status: providerResponse.status, statusText: providerResponse.statusText, headers: providerResponse.headers }) };
      }

      if (foundTerminal) {
        await reader.cancel().catch(() => {});
        logPreflight("warn", "failed", "reason=terminal_before_content");
        return { error: "Empty upstream stream before content", status: HTTP_STATUS.BAD_GATEWAY };
      }

      // foundSemantic / foundHeartbeat: hasByte = true, reset lastByteTime
      // Cap: hasByte -> 9s no content -> fallback
      if (foundSemantic || foundHeartbeat) {
        timing.lastNonProductiveAt = Date.now();
        lastByteTime = timing.lastNonProductiveAt;
      }

      pendingRead = reader.read();
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    logPreflight("warn", "failed", `reason=${JSON.stringify(error.message || "Upstream stream preflight failed")}`);
    return { error: error.message || "Upstream stream preflight failed", status: HTTP_STATUS.BAD_GATEWAY };
  }
  await reader.cancel().catch(() => {});
  const suffix = hasByte ? "before content" : "without bytes";
  log?.warn?.("STREAM", (provider?.toUpperCase?.() || provider) + " | " + model + " | empty " + suffix);
  return { error: "Empty upstream stream " + suffix, status: HTTP_STATUS.BAD_GATEWAY };
}

function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;
  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey);
  }
  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey);
  }
  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, streamController, onStreamComplete, log, streamTimeoutPolicy, routeInfo, retryFn, emptyStreamRetryDelayMs = PREFLIGHT_TICK_MS }) {
  let guarded = await guardInitialStream(providerResponse, { targetFormat, log, provider, model, policy: streamTimeoutPolicy, routeInfo });
  if (guarded.error && retryFn && isRetryableEmptyStreamError(guarded.error)) {
    log?.warn?.("STREAM", `${provider?.toUpperCase?.() || provider} | ${model} | empty upstream stream, retrying after ${emptyStreamRetryDelayMs}ms`);
    await wait(emptyStreamRetryDelayMs);
    try {
      const retryResult = await retryFn();
      if (retryResult?.response) {
        providerResponse = retryResult.response;
        guarded = await guardInitialStream(providerResponse, { targetFormat, log, provider, model, policy: streamTimeoutPolicy, routeInfo });
      }
    } catch (retryError) {
      log?.warn?.("STREAM", `${provider?.toUpperCase?.() || provider} | ${model} | empty upstream stream retry failed: ${retryError.message || retryError}`);
    }
  }
  if (guarded.error) {
    streamController.handleError(new Error(guarded.error));
    return createErrorResult(guarded.status, guarded.error);
  }
  providerResponse = guarded.response;
  if (onRequestSuccess) await onRequestSuccess();
  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey });
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const stallTimeoutMs = streamTimeoutPolicy?.idleAfterProductiveMs || PROVIDERS[provider]?.stallTimeoutMs || 180000;
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs);
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId, apiKey, routeInfo,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });
  return { success: true, response: new Response(transformedBody, { headers: SSE_HEADERS }) };
}

export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, routeInfo }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, apiKey, routeInfo,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", routeInfo });
  };
  return { onStreamComplete, streamDetailId };
}
