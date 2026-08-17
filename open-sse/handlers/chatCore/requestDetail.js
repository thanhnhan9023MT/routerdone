import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { appendRequestConsoleLog } from "@/lib/consoleLogBuffer.js";
import { COLORS } from "../../utils/stream.js";

// Verbose per-attempt usage line. Fires on every combo attempt (up to
// models×retries per user request) and was a CPU/IO contributor on loaded
// deploys. Quiet in production unless LOG_LEVEL=DEBUG|INFO or ENABLE_REQUEST_LOGS.
const VERBOSE_LOGS = (() => {
  const lvl = (process.env.LOG_LEVEL || "").toUpperCase();
  if (lvl === "DEBUG" || lvl === "INFO") return true;
  if (process.env.ENABLE_REQUEST_LOGS === "true") return true;
  if (process.env.NODE_ENV === "production") return false;
  return true;
})();

const OPTIONAL_PARAMS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens
    };
  }

  // OpenAI format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens: responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens
    };
  }

  // Gemini format
  if (responseBody.usageMetadata) {
    return {
      prompt_tokens: responseBody.usageMetadata.promptTokenCount || 0,
      completion_tokens: responseBody.usageMetadata.candidatesTokenCount || 0,
      reasoning_tokens: responseBody.usageMetadata.thoughtsTokenCount
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    apiKey: base.apiKey || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: base.tokens || { prompt_tokens: 0, completion_tokens: 0 },
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    requestedModel: base.routeInfo?.requestedModel || base.requestedModel || base.request?.model || base.model || "unknown",
    attemptModel: base.routeInfo?.attemptModel || base.attemptModel || base.request?.model || base.model || "unknown",
    actualModel: base.routeInfo?.actualModel || base.actualModel || base.model || "unknown",
    routeInfo: base.routeInfo || null,
    status: base.status || "success",
    ...overrides
  };
}

export function logChatRequestComplete({ status = 200, stream = false, provider, model, latency, tokens, displayProvider = null, routeInfo = null }) {
  appendRequestConsoleLog({
    status,
    stream,
    provider,
    model,
    duration: latency?.total || 0,
    ttft: latency?.ttft || 0,
    tokens: tokens || {},
    displayProvider: displayProvider || null,
    comboName: routeInfo?.comboName || null,
  });
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, label = "USAGE", routeInfo = null }) {
  if (!tokens || typeof tokens !== "object") return;

  const inTokens = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const outTokens = tokens.output_tokens ?? tokens.completion_tokens ?? 0;

  if (inTokens === 0 && outTokens === 0) return;

  const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
  if (VERBOSE_LOGS) console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);

  // Normalize to OpenAI token shape for storage
  const normalized = {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0
  };

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    meta: routeInfo || null
  }).catch(() => {});
}
