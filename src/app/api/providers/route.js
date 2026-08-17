import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
  getProviderNodeById,
  getProviderNodes,
  getProxyPoolById,
} from "@/models";
import { APIKEY_PROVIDERS } from "@/shared/constants/config";
import { AI_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "@/shared/constants/providers";
import { normalizeProviderId, normalizeProviderSpecificData } from "@/lib/providerNormalization";
import { normalizeStaleConnectionState } from "open-sse/services/accountFallback.js";
import { updateProviderConnection } from "@/models";

export const dynamic = "force-dynamic";

function normalizeProxyConfig(body = {}) {
  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return { error: "Connection proxy URL is required when connection proxy is enabled" };
  }

  return {
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolId(proxyPoolId) {
  if (proxyPoolId === undefined || proxyPoolId === null || proxyPoolId === "" || proxyPoolId === "__none__") {
    return { proxyPoolId: null };
  }

  const normalizedId = String(proxyPoolId).trim();
  if (!normalizedId) {
    return { proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(normalizedId);
  if (!proxyPool) {
    return { error: "Proxy pool not found" };
  }

  return { proxyPoolId: normalizedId };
}

// GET /api/providers - List all connections
export async function GET() {
  try {
    const rawConnections = await getProviderConnections();
    const connections = [];
    for (const connection of rawConnections) {
      const stale = normalizeStaleConnectionState(connection);
      if (stale.needsUpdate) {
        connections.push(await updateProviderConnection(connection.id, stale.update) || connection);
      } else {
        connections.push(connection);
      }
    }

    // Build nodeNameMap for compatible providers (id → name)
    let nodeNameMap = {};
    try {
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node.id && node.name) nodeNameMap[node.id] = node.name;
      }
    } catch { }

    // Hide sensitive fields, enrich name for compatible providers
    const safeConnections = connections.map(c => {
      const isCompatible = isOpenAICompatibleProvider(c.provider) || isAnthropicCompatibleProvider(c.provider);
      const name = isCompatible
        ? (c.name || nodeNameMap[c.provider] || c.providerSpecificData?.nodeName || c.provider)
        : c.name;
      return {
        ...c,
        name,
        apiKey: undefined,
        accessToken: undefined,
        refreshToken: undefined,
        idToken: undefined,
      };
    });

    return NextResponse.json({ connections: safeConnections });
  } catch (error) {
    console.log("Error fetching providers:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}

// POST /api/providers - Create new connection (API Key only, OAuth via separate flow)
export async function POST(request) {
  try {
    const body = await request.json();
    const provider = normalizeProviderId(body.provider);
    const { apiKey, name, displayName, priority, globalPriority, defaultModel, testStatus } = body;
    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolId(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }
    const proxyPoolId = proxyPoolResult.proxyPoolId;

    // Validation
    const isWebCookieProvider = !!WEB_COOKIE_PROVIDERS[provider];
    // Dual-auth providers (e.g. codebuddy-cn, xai) live under category "oauth" but also
    // accept an API key via authModes — they aren't in APIKEY_PROVIDERS, so allow them here.
    const supportsApiKeyMode = !!AI_PROVIDERS[provider]?.authModes?.includes("apikey");
    const isValidProvider = APIKEY_PROVIDERS[provider] ||
      FREE_TIER_PROVIDERS[provider] ||
      supportsApiKeyMode ||
      isWebCookieProvider ||
      isOpenAICompatibleProvider(provider) ||
      isAnthropicCompatibleProvider(provider) ||
      isCustomEmbeddingProvider(provider);

    if (!provider || !isValidProvider) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    if (!apiKey && provider !== "ollama-local") {
      return NextResponse.json({ error: `${isWebCookieProvider ? "Cookie value" : "API Key"} is required` }, { status: 400 });
    }
    const connectionName = name || displayName || AI_PROVIDERS[provider]?.name;
    if (!connectionName) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    let providerSpecificData = normalizeProviderSpecificData(provider, body, body.providerSpecificData);

    // Compatible/embedding nodes may hold MANY connections — one per API key — so a
    // single node can spread load across several accounts of the same upstream. The
    // request path already supports this: sse/handlers/chat.js loops over available
    // accounts (excludeConnectionIds) and sse/services/auth.js picks between them by
    // strategy (lastUsedAt rotation, else priority). Historic proof: EuroModels and
    // JetNight each ran 20 connections on one node, xai 12.
    //
    // What is rejected is a DUPLICATE key on the same node: adding the same credential
    // twice silently doubles that account's share of the rotation and hides a quota it
    // does not really have. (Before 2026-08-17 this was implemented as a blunt
    // one-connection-per-node cap; the test it honored — #925 — posts the same
    // "test-key" twice, i.e. it was always describing the duplicate case.)
    const rejectDuplicateKey = async (label) => {
      if (!apiKey) return null;
      const existing = await getProviderConnections({ provider });
      const clash = existing.some((c) => {
        const k = c?.apiKey ?? c?.data?.apiKey ?? c?.providerSpecificData?.apiKey;
        return typeof k === "string" && k === apiKey;
      });
      if (clash) {
        return NextResponse.json(
          { error: `This API key is already connected to the ${label} node — add a different key to spread load` },
          { status: 400 }
        );
      }
      // A same-NAME connection must be refused explicitly, because
      // connectionsRepo.upsertProviderConnection dedups apikey connections by
      // (provider, name) and MERGES — a second key posted under an existing name
      // would overwrite the first key, return 201, and leave one row. The caller
      // would believe it has two accounts while one credential was destroyed.
      // Rotating a key on purpose is PUT /api/providers/<id>, not a re-POST.
      if (connectionName && existing.some((c) => c?.authType === "apikey" && c?.name === connectionName)) {
        return NextResponse.json(
          {
            error:
              `The ${label} node already has a connection named "${connectionName}" — ` +
              `give the new key a different name (e.g. "${connectionName} #2"), ` +
              `or use PUT /api/providers/<id> to rotate the existing key`,
          },
          { status: 400 }
        );
      }
      return null;
    };

    if (isOpenAICompatibleProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "OpenAI Compatible node not found" }, { status: 404 });
      }
      const dup = await rejectDuplicateKey("OpenAI Compatible");
      if (dup) return dup;
      providerSpecificData = {
        ...(node.data || {}),
        prefix: node.prefix,
        apiType: node.apiType,
        baseUrl: node.baseUrl,
        nodeName: node.name,
        runtimeProfile: node.runtimeProfile || node.data?.runtimeProfile || "standard",
        ...(node.transport || node.data?.transport ? { transport: node.transport || node.data.transport } : {}),
      };
    } else if (isAnthropicCompatibleProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "Anthropic Compatible node not found" }, { status: 404 });
      }
      const dup = await rejectDuplicateKey("Anthropic Compatible");
      if (dup) return dup;
      providerSpecificData = {
        prefix: node.prefix,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    } else if (isCustomEmbeddingProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "Custom Embedding node not found" }, { status: 404 });
      }
      const dup = await rejectDuplicateKey("Custom Embedding");
      if (dup) return dup;
      providerSpecificData = {
        prefix: node.prefix,
        baseUrl: node.baseUrl,
        nodeName: node.name,
      };
    }

    const mergedProviderSpecificData = {
      ...(providerSpecificData || {}),
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled,
      connectionProxyUrl: proxyConfig.connectionProxyUrl,
      connectionNoProxy: proxyConfig.connectionNoProxy,
    };

    if (proxyPoolId !== null) {
      mergedProviderSpecificData.proxyPoolId = proxyPoolId;
    }

    const newConnection = await createProviderConnection({
      provider,
      authType: isWebCookieProvider ? "cookie" : "apikey",
      name: connectionName,
      apiKey: apiKey || "",
      priority: priority || 1,
      globalPriority: globalPriority || null,
      defaultModel: defaultModel || null,
      providerSpecificData: mergedProviderSpecificData,
      isActive: true,
      testStatus: testStatus || "unknown",
    });

    // Hide sensitive fields
    const result = { ...newConnection };
    delete result.apiKey;

    return NextResponse.json({ connection: result }, { status: 201 });
  } catch (error) {
    console.log("Error creating provider:", error);
    return NextResponse.json({ error: "Failed to create provider" }, { status: 500 });
  }
}
