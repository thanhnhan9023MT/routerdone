import { describe, expect, it } from "vitest";
import { buildProviderEndpoint, normalizeProviderBaseUrl, normalizeRuntimeProfile } from "../../src/lib/providerTransport.js";

describe("connection-scoped provider transport", () => {
  it("defaults unknown profiles to standard without inference", () => {
    expect(normalizeRuntimeProfile(undefined)).toBe("standard");
    expect(normalizeRuntimeProfile("LM Studio")).toBe("standard");
  });

  it("normalizes explicit LM Studio base URLs to OpenAI v1", () => {
    expect(normalizeProviderBaseUrl("http://127.0.0.1:1234", { runtimeProfile: "lmstudio_local" }))
      .toBe("http://127.0.0.1:1234/v1");
    expect(buildProviderEndpoint("http://127.0.0.1:1234/v1/chat/completions", "/models", { runtimeProfile: "lmstudio_local" }))
      .toBe("http://127.0.0.1:1234/v1/models");
  });

  it("preserves standard provider paths and query strings", () => {
    expect(buildProviderEndpoint("https://example.test/api/v1/", "/models"))
      .toBe("https://example.test/api/v1/models");
  });

  it("rejects unsupported protocols and URL credentials", () => {
    expect(() => normalizeProviderBaseUrl("file:///tmp/model")).toThrow("URL protocol");
    expect(() => normalizeProviderBaseUrl("https://user:pass@example.test/v1")).toThrow("credentials");
  });
});
