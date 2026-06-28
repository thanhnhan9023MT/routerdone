import { claudeToOpenAIRequest } from "../translator/request/claude-to-openai.js";
import { openaiToClaudeRequest } from "../translator/request/openai-to-claude.js";
import { openaiResponsesToOpenAIRequest, openaiToOpenAIResponsesRequest } from "../translator/request/openai-responses.js";

const DEFAULT_TIMEOUT_MS = 3000;

function maskEndpoint(value) {
  try {
    const u = new URL(String(value));
    u.username = "";
    u.password = "";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return String(value || "").replace(/\/[^\s?#]*\?[^\s]*/g, "").replace(/\/\/[^:@\s]+:[^@\s]+@/g, "//");
  }
}

function appendCompressPath(url) {
  const raw = String(url);
  try {
    const u = new URL(raw);
    u.pathname = `${u.pathname.replace(/\/$/, "")}/v1/compress`;
    return u.toString();
  } catch {
    return `${raw.replace(/\/$/, "")}/v1/compress`;
  }
}

function jsonSize(value) {
  try {
    return JSON.stringify(value ?? {}).length;
  } catch {
    return 0;
  }
}

function normalizeErrorMessage(error, endpoint) {
  const msg = error?.message || String(error || "request failed");
  const maskedEndpoint = maskEndpoint(endpoint);
  const maskedMsg = msg
    .replace(/https?:\/\/[^\s]+/g, (match) => maskEndpoint(match))
    .replace(/\b(user|secret|token=)[^\s]*/gi, "[redacted]");
  return `${maskedMsg} | endpoint=${maskedEndpoint}`;
}

// POST messages to Headroom /v1/compress; returns compressed messages + stats or null.
async function callCompress(url, messages, model, timeoutMs, compressUserMessages, diagnostics) {
  const endpoint = appendCompressPath(url);
  const payload = { messages, model };
  if (compressUserMessages) payload.config = { compress_user_messages: true };
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      diagnostics.reason = `request failed: HTTP ${res.status} | endpoint=${maskEndpoint(endpoint)}`;
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data?.messages)) {
      diagnostics.reason = `invalid response: missing messages[] | endpoint=${maskEndpoint(endpoint)}`;
      return null;
    }
    diagnostics.endpoint = maskEndpoint(endpoint);
    return data;
  } catch (error) {
    diagnostics.reason = `request failed: ${normalizeErrorMessage(error, endpoint)}`;
    return null;
  }
}

// Compress request body via Headroom proxy. Fail-open: returns null on any error.
// /v1/compress only understands OpenAI messages, so non-chat bodies are translated
// to OpenAI, compressed, then translated back using RouterDone's translators.
export async function compressWithHeadroom(body, { enabled, url, model, format, compressUserMessages, timeoutMs = DEFAULT_TIMEOUT_MS, diagnostics = null } = {}) {
  if (!enabled || !url || !body) {
    if (diagnostics) diagnostics.reason = "disabled or missing url/body";
    return null;
  }

  const diag = diagnostics || {};
  diag.bodyBeforeBytes = jsonSize(body);

  try {
    if (format === "claude") {
      const oai = claudeToOpenAIRequest(model, body, false);
      if (!Array.isArray(oai?.messages)) {
        diag.reason = "no OpenAI messages after Claude translation";
        return null;
      }
      diag.messagesBeforeBytes = jsonSize(oai.messages);
      const data = await callCompress(url, oai.messages, model, timeoutMs, compressUserMessages, diag);
      if (!data) return null;
      const claudeBody = openaiToClaudeRequest(model, { ...oai, messages: data.messages }, false);
      if (Array.isArray(claudeBody?.messages)) body.messages = claudeBody.messages;
      if (claudeBody?.system !== undefined) body.system = claudeBody.system;
      diag.messagesAfterBytes = jsonSize(data.messages);
      diag.bodyAfterBytes = jsonSize(body);
      return data;
    }

    if (format === "openai-responses") {
      const oai = openaiResponsesToOpenAIRequest(model, body, false);
      if (!Array.isArray(oai?.messages)) {
        diag.reason = "no OpenAI messages after Responses translation";
        return null;
      }
      diag.messagesBeforeBytes = jsonSize(oai.messages);
      const data = await callCompress(url, oai.messages, model, timeoutMs, compressUserMessages, diag);
      if (!data) return null;
      const responsesBody = openaiToOpenAIResponsesRequest(model, { ...oai, messages: data.messages }, false);
      if (Array.isArray(responsesBody?.input)) body.input = responsesBody.input;
      if (responsesBody?.instructions !== undefined) body.instructions = responsesBody.instructions;
      diag.messagesAfterBytes = jsonSize(data.messages);
      diag.bodyAfterBytes = jsonSize(body);
      return data;
    }

    const key = Array.isArray(body.messages) ? "messages" : null;
    if (!key) {
      diag.reason = "no messages[] to compress";
      return null;
    }
    diag.messagesBeforeBytes = jsonSize(body[key]);
    const data = await callCompress(url, body[key], model, timeoutMs, compressUserMessages, diag);
    if (!data) return null;
    body[key] = data.messages;
    diag.messagesAfterBytes = jsonSize(body[key]);
    diag.bodyAfterBytes = jsonSize(body);
    return data;
  } catch (error) {
    diag.reason = `request failed: ${normalizeErrorMessage(error, url)}`;
    return null;
  }
}

export function formatHeadroomLog(stats) {
  if (!stats) return null;
  const before = stats.tokens_before || 0;
  const after = stats.tokens_after || 0;
  const saved = stats.tokens_saved || 0;
  const pct = before > 0 ? ((saved / before) * 100).toFixed(1) : "0";
  return `saved ${saved} tokens / ${before} (${pct}%) ${after ? `after=${after}` : ""}`.trim();
}

export function formatHeadroomSizeLog(stats, diagnostics = {}) {
  if (!stats) return null;
  const before = stats.tokens_before || 0;
  const after = stats.tokens_after || 0;
  const saved = stats.tokens_saved || 0;
  return `reported token delta=${saved} before=${before} after=${after} | body=${diagnostics.bodyBeforeBytes || 0}->${diagnostics.bodyAfterBytes || 0}B | messages=${diagnostics.messagesBeforeBytes || 0}->${diagnostics.messagesAfterBytes || 0}B`;
}

export function isHeadroomPhantomSavings(stats, diagnostics = {}) {
  if (!stats?.tokens_saved) return false;
  const before = diagnostics.bodyBeforeBytes || 0;
  const after = diagnostics.bodyAfterBytes || 0;
  if (before <= 0 || after <= 0) return false;
  return ((before - after) / before) < 0.05;
}