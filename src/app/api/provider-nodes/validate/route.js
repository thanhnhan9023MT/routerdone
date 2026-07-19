import { NextResponse } from "next/server";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { isLocalRequest } from "@/dashboardGuard";
import { buildProviderEndpoint, normalizeProviderBaseUrl, normalizeRuntimeProfile } from "@/lib/providerTransport";

// Fetch with timeout wrapper
const fetchWithTimeout = (url, options, timeout = 10000) => {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Request timeout")), timeout)
    )
  ]);
};

// Validate URL format
const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

// Parse error details for user-friendly messages
const getErrorMessage = (error) => {
  if (error.cause?.code === "ECONNREFUSED") return "Connection refused - provider node offline or unreachable";
  if (error.cause?.code === "ENOTFOUND") return "DNS lookup failed - invalid domain or network issue";
  if (error.cause?.code === "ETIMEDOUT") return "Connection timeout - provider node too slow";
  if (error.message.includes("timeout")) return "Request timeout (>10s) - provider node not responding";
  if (error.cause?.code === "CERT_HAS_EXPIRED") return "SSL certificate expired";
  if (error.cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "SSL certificate verification failed";
  if (error.cause?.code) return `Network error: ${error.cause.code}`;
  return "Network connection failed - check URL and network connectivity";
};

// Get status-specific error message for /models endpoint
const getModelsErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 404) return "/models endpoint not found - try chat validation with model ID";
  if (status >= 500) return "Server error - try again later";
  return `Unexpected response (${status})`;
};

// Get status-specific error message for /chat/completions endpoint
const getChatErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 400) return "Invalid model or bad request";
  if (status === 404) return "Chat endpoint not found";
  if (status >= 500) return "Server error - try again later";
  return `Chat request failed (${status})`;
};

// POST /api/provider-nodes/validate - Validate API key against base URL
export async function POST(request) {
  try {
    const body = await request.json();
    const { baseUrl, apiKey, type, modelId } = body;
    const runtimeProfile = normalizeRuntimeProfile(body.runtimeProfile);

    if (!baseUrl || !apiKey) {
      return NextResponse.json({ error: "Base URL and API key required" }, { status: 400 });
    }

    let normalizedBase;
    try {
      normalizedBase = normalizeProviderBaseUrl(baseUrl, { runtimeProfile, transport: type === "anthropic-compatible" ? "anthropic" : "openai" });
    } catch (error) {
      return NextResponse.json({ error: error.message || "Invalid URL format" }, { status: 400 });
    }

    // SSRF guard for remote callers; local host keeps explicit self-hosted profiles (e.g. lmstudio_local)
    if (!isLocalRequest(request)) {
      try {
        assertPublicUrl(normalizedBase);
      } catch {
        return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
      }
    }

    // Custom Embedding Validation - test POST /embeddings directly
    if (type === "custom-embedding") {
      if (!modelId?.trim()) {
        return NextResponse.json({ valid: false, error: "Model ID required for embedding validation" });
      }
      const embedRes = await fetchWithTimeout(buildProviderEndpoint(normalizedBase, "/embeddings", { runtimeProfile }), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: modelId.trim(), input: "ping" })
      });
      if (embedRes.ok) {
        const data = await embedRes.json().catch(() => null);
        const dims = Array.isArray(data?.data?.[0]?.embedding) ? data.data[0].embedding.length : null;
        return NextResponse.json({ valid: true, method: "embeddings", dimensions: dims });
      }
      if (embedRes.status === 401 || embedRes.status === 403) {
        return NextResponse.json({ valid: false, error: "API key unauthorized" });
      }
      const errBody = await embedRes.text().catch(() => "");
      return NextResponse.json({
        valid: false,
        error: `Embeddings request failed (${embedRes.status})${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
        method: "embeddings"
      });
    }

    // Anthropic Compatible Validation
    if (type === "anthropic-compatible") {
      const modelsUrl = buildProviderEndpoint(normalizedBase, "/models", { transport: "anthropic" });
      const res = await fetchWithTimeout(modelsUrl, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Authorization": `Bearer ${apiKey}`
        }
      });

      if (res.ok) return NextResponse.json({ valid: true });

      // Auth errors - no point trying chat fallback
      if (res.status === 401 || res.status === 403) {
        return NextResponse.json({ valid: false, error: "API key unauthorized" });
      }

      // Fallback: try chat/completions if modelId provided
      if (modelId) {
        const chatRes = await fetchWithTimeout(buildProviderEndpoint(normalizedBase, "/chat/completions", { transport: "anthropic" }), {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1
          })
        });
        if (chatRes.ok) {
          return NextResponse.json({ valid: true, method: "chat" });
        }
        return NextResponse.json({
          valid: false,
          error: getChatErrorMessage(chatRes.status),
          method: "chat"
        });
      }

      return NextResponse.json({ valid: false, error: getModelsErrorMessage(res.status) });
    }

    // OpenAI Compatible Validation (Default)
    const modelsUrl = buildProviderEndpoint(normalizedBase, "/models", { runtimeProfile });
    const res = await fetchWithTimeout(modelsUrl, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (res.ok) return NextResponse.json({ valid: true });

    // Auth errors - no point trying chat fallback
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ valid: false, error: "API key unauthorized" });
    }

    // Fallback: try chat/completions if modelId provided
    if (modelId) {
      const chatRes = await fetchWithTimeout(buildProviderEndpoint(normalizedBase, "/chat/completions", { runtimeProfile }), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        })
      });
      if (chatRes.ok) {
        return NextResponse.json({ valid: true, method: "chat" });
      }
      return NextResponse.json({
        valid: false,
        error: getChatErrorMessage(chatRes.status),
        method: "chat"
      });
    }

    return NextResponse.json({ valid: false, error: getModelsErrorMessage(res.status) });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("Error validating provider node:", {
      message: error.message,
      cause: error.cause,
      code: error.cause?.code,
      userMessage: errorMessage
    });
    return NextResponse.json({ 
      valid: false,
      error: errorMessage 
    }, { status: 500 });
  }
}
