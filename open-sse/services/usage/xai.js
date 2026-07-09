/**
 * xAI (Grok) usage handler.
 *
 * xAI has no dedicated usage/billing endpoint (GET /v1/models returns no
 * rate-limit headers; /v1/usage and /v1/billing are 404). The only place the
 * per-account quota is exposed is the `x-ratelimit-*` response headers on
 * POST /v1/chat/completions. So we fire a minimal streamed request
 * (max_tokens: 1), read the headers, and cancel the body without consuming the
 * stream — the headers arrive with the response head, before any reasoning.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";
// xAI rate-limit is PER-MODEL — probe the model actually sold (grok-4.5). With
// stream:true the rate-limit headers arrive on the response head (before any
// reasoning), so a reasoning model still resolves fast; the body is cancelled.
const XAI_PROBE_MODEL = "grok-4.5";

export async function getXaiUsage(accessToken, proxyOptions = null) {
  try {
    const resp = await proxyAwareFetch(XAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "grok-cli/routerdone",
      },
      body: JSON.stringify({
        model: XAI_PROBE_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: true,
      }),
    }, proxyOptions);

    const h = resp.headers;
    const num = (k) => {
      const v = Number(h.get(k));
      return Number.isFinite(v) ? v : null;
    };
    const rt = num("x-ratelimit-remaining-tokens");
    const lt = num("x-ratelimit-limit-tokens");
    const rr = num("x-ratelimit-remaining-requests");
    const lr = num("x-ratelimit-limit-requests");

    // free the connection without draining the whole stream
    try { await resp.body?.cancel?.(); } catch { /* best effort */ }

    if (lt === null && lr === null) {
      if (!resp.ok) return { message: `Grok connected. Usage unavailable (HTTP ${resp.status}).` };
      return { message: "Grok connected. Rate-limit headers unavailable." };
    }

    const quotas = {};
    const mk = (remaining, total) => ({
      used: Math.max(0, total - remaining),
      total,
      remaining,
      remainingPercentage: total > 0 ? Math.round((remaining / total) * 100) : 0,
      unlimited: false,
    });
    if (lt !== null && lt > 0 && rt !== null) quotas["tokens"] = mk(rt, lt);
    if (lr !== null && lr > 0 && rr !== null) quotas["requests"] = mk(rr, lr);

    return { plan: "Grok (xAI)", quotas };
  } catch (error) {
    return { message: `Grok connected. Unable to fetch usage: ${error.message}` };
  }
}
