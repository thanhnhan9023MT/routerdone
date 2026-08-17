import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupTestContext(nodeData) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "routerdone-compatible-provider-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const { POST } = await import("@/app/api/providers/route.js");
  const {
    createProviderNode,
    getProviderConnections,
  } = await import("@/models/index.js");

  const node = await createProviderNode(nodeData);

  return {
    node,
    POST,
    getProviderConnections,
    cleanup() {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep sqlite handles briefly after tests finish.
      }
    },
  };
}

function makeRequest(provider, overrides = {}) {
  return new Request("https://routerdone.local/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      apiKey: "test-key",
      name: "Test Connection",
      defaultModel: "test-model",
      ...overrides,
    }),
  });
}

function expectCompatibleConnection(connection, node, { apiType } = {}) {
  expect(connection.provider).toBe(node.id);
  expect(connection.authType).toBe("apikey");
  expect(connection.defaultModel).toBe("test-model");
  expect(connection.providerSpecificData).toMatchObject({
    prefix: node.prefix,
    baseUrl: node.baseUrl,
    nodeName: node.name,
  });

  if (apiType !== undefined) {
    expect(connection.providerSpecificData.apiType).toBe(apiType);
  }
}

describe("compatible provider connections API", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("creates one API-key connection for an OpenAI-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-test",
      type: "openai-compatible",
      name: "OpenAI Compatible Test Node",
      prefix: "oct",
      apiType: "chat",
      baseUrl: "https://openai-compatible.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    const body = await response.json();
    const connection = body.connection;
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(connection, ctx.node, { apiType: "chat" });
    expect(storedConnections[0]).toMatchObject({
      provider: ctx.node.id,
      authType: "apikey",
      defaultModel: "test-model",
      providerSpecificData: {
        prefix: ctx.node.prefix,
        apiType: "chat",
        baseUrl: ctx.node.baseUrl,
        nodeName: ctx.node.name,
      },
    });
  });

  it("creates one API-key connection for an Anthropic-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "anthropic-compatible-test",
      type: "anthropic-compatible",
      name: "Anthropic Compatible Test Node",
      prefix: "act",
      baseUrl: "https://anthropic-compatible.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    const body = await response.json();
    const connection = body.connection;
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(connection, ctx.node);
    expect(storedConnections[0]).toMatchObject({
      provider: ctx.node.id,
      authType: "apikey",
      defaultModel: "test-model",
      providerSpecificData: {
        prefix: ctx.node.prefix,
        baseUrl: ctx.node.baseUrl,
        nodeName: ctx.node.name,
      },
    });
  });

  // Same key twice on one node is still rejected: it would silently double that
  // account's share of the rotation in sse/services/auth.js and pretend a quota
  // the account does not have.
  it("returns 400 for a duplicate API KEY on the same compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-duplicate-test",
      type: "openai-compatible",
      name: "Duplicate Guard Node",
      prefix: "dup",
      apiType: "chat",
      baseUrl: "https://duplicate-guard.test/v1",
    });
    cleanup = ctx.cleanup;

    const firstResponse = await ctx.POST(makeRequest(ctx.node.id));
    const secondResponse = await ctx.POST(makeRequest(ctx.node.id)); // same "test-key"
    const secondBody = await secondResponse.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(400);
    expect(secondBody.error).toContain("already connected");
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(storedConnections[0], ctx.node, { apiType: "chat" });
  });

  // A node may hold one connection PER KEY, so one node can spread load over
  // several accounts of the same upstream (ohhmyagent's two keys, euro's 20…).
  it("accepts a second connection with a DIFFERENT key on the same node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-multikey-test",
      type: "openai-compatible",
      name: "Multi Key Node",
      prefix: "mk",
      apiType: "chat",
      baseUrl: "https://multi-key.test/v1",
    });
    cleanup = ctx.cleanup;

    const first = await ctx.POST(makeRequest(ctx.node.id));
    const second = await ctx.POST(makeRequest(ctx.node.id, { apiKey: "test-key-2", name: "Second Key" }));
    const stored = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(stored).toHaveLength(2);
    // Both inherit the node's transport settings, differing only by credential.
    for (const conn of stored) expectCompatibleConnection(conn, ctx.node, { apiType: "chat" });
    expect(new Set(stored.map((c) => c.apiKey))).toEqual(new Set(["test-key", "test-key-2"]));
  });

  // connectionsRepo.upsertProviderConnection dedups apikey rows by (provider, name)
  // and MERGES, so a second key posted under an existing name silently overwrote the
  // first key and still returned 201 — one row, one credential destroyed. Refuse it.
  it("returns 400 for a second key posted under an EXISTING name (would overwrite)", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-samename-test",
      type: "openai-compatible",
      name: "Same Name Node",
      prefix: "sn",
      apiType: "chat",
      baseUrl: "https://same-name.test/v1",
    });
    cleanup = ctx.cleanup;

    const first = await ctx.POST(makeRequest(ctx.node.id));
    // different key, SAME name ("Test Connection")
    const second = await ctx.POST(makeRequest(ctx.node.id, { apiKey: "test-key-2" }));
    const body = await second.json();
    const stored = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(first.status).toBe(201);
    expect(second.status).toBe(400);
    expect(body.error).toContain("different name");
    // the first credential must survive untouched
    expect(stored).toHaveLength(1);
    expect(stored[0].apiKey).toBe("test-key");
  });

  it("accepts a second key on an ANTHROPIC-compatible node too", async () => {
    const ctx = await setupTestContext({
      id: "anthropic-compatible-multikey-test",
      type: "anthropic-compatible",
      name: "Anthropic Multi Key Node",
      prefix: "amk",
      baseUrl: "https://anthropic-multi-key.test/v1",
    });
    cleanup = ctx.cleanup;

    const first = await ctx.POST(makeRequest(ctx.node.id));
    const second = await ctx.POST(makeRequest(ctx.node.id, { apiKey: "test-key-2", name: "Second Key" }));
    const stored = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(stored).toHaveLength(2);
  });
});
