import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS, shouldForceNonStreamUpstream, FORCE_NONSTREAM_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";

/**
 * Build an OpenAI-style SSE body from a complete chat.completion JSON so the rest of
 * the pipeline (stream translators, combo, SSE→JSON) sees a normal upstream stream.
 * Used for FORCE_NONSTREAM_UPSTREAM_MODELS (upstreams that EOF on stream:true).
 */
function buildSSETextFromCompletion(json, fallbackModel) {
  const base = {
    id: json?.id || `chatcmpl-synth-${Date.now()}`,
    object: "chat.completion.chunk",
    created: json?.created || Math.floor(Date.now() / 1000),
    model: json?.model || fallbackModel,
  };
  const chunks = [];
  const choices = Array.isArray(json?.choices) && json.choices.length ? json.choices : [{}];
  for (const choice of choices) {
    const index = choice.index ?? 0;
    const msg = choice.message || {};
    const mk = (delta) => ({ ...base, choices: [{ index, delta, finish_reason: null }] });
    chunks.push(mk({ role: msg.role || "assistant" }));
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length) {
      chunks.push(mk({ reasoning_content: msg.reasoning_content }));
    }
    if (typeof msg.content === "string" && msg.content.length) {
      chunks.push(mk({ content: msg.content }));
    }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      chunks.push(mk({ tool_calls: msg.tool_calls.map((tc, i) => ({ index: i, ...tc })) }));
    }
    const final = { ...base, choices: [{ index, delta: {}, finish_reason: choice.finish_reason || "stop" }] };
    if (json?.usage) final.usage = json.usage;
    chunks.push(final);
  }
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const apiType = credentials?.providerSpecificData?.apiType;
      const path = apiType === "responses" || (!apiType && this.provider.includes("responses")) ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    // response (optional) lets a subclass hook compute a dynamic delay (e.g. antigravity Retry-After).
    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      // Hook: subclass may derive delay from the response (headers/body). null → skip retry, use fallback.
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs);
        if (dynamic === false) return false; // hook vetoes retry (e.g. Retry-After too long)
        if (dynamic != null) waitMs = dynamic;
      }
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      // Upstreams that EOF on stream:true (FORCE_NONSTREAM_UPSTREAM_MODELS): send
      // stream:false and synthesize SSE from the JSON reply after the fetch below.
      // Clone (don't mutate) so a chatCore retry re-detects from the original body.
      const forceNonStream = transformedBody?.stream === true
        && shouldForceNonStreamUpstream(this.provider, transformedBody?.model || model);
      let sendBody = transformedBody;
      if (forceNonStream) {
        sendBody = { ...transformedBody, stream: false };
        delete sendBody.stream_options; // invalid on strict upstreams when stream=false
      }
      const headers = this.buildHeaders(credentials, forceNonStream ? false : stream);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within connection timeout.
      // Non-stream upstreams only return headers once generation completes → longer cap.
      const connectCtrl = new AbortController();
      const timeoutMs = forceNonStream
        ? Math.max(this.config?.timeoutMs || 0, FORCE_NONSTREAM_CONNECT_TIMEOUT_MS)
        : (this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS);
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(sendBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${timeoutMs}ms`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal
        }, proxyOptions);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`, response)) { urlIndex--; continue; }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        if (forceNonStream && response.ok) {
          const rawText = await response.text();
          let json = null;
          try { json = JSON.parse(rawText); } catch { /* handled below */ }
          if (!json) {
            dbg("FETCH", `${this.provider.toUpperCase()} forced non-stream: invalid JSON (${rawText.length}B) → 502`);
            const errResp = new Response(rawText || "invalid JSON from upstream (forced non-stream)", {
              status: HTTP_STATUS.BAD_GATEWAY,
              headers: { "content-type": "text/plain" },
            });
            return { response: errResp, url, headers, transformedBody: sendBody };
          }
          const sseText = buildSSETextFromCompletion(json, sendBody.model || model);
          dbg("FETCH", `${this.provider.toUpperCase()} forced non-stream → synthesized SSE (${sseText.length}B)`);
          const sseResp = new Response(sseText, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
          return { response: sseResp, url, headers, transformedBody: sendBody };
        }

        return { response, url, headers, transformedBody: sendBody };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Connect timeout is internal — convert to retryable network error, don't propagate AbortError
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        // Map network/fetch exceptions to 502 retry config
        if (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`)) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
