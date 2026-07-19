import { describe, expect, it } from "vitest";
import { normalizeLmstudioMessages, resolveRuntimeProfileConfig } from "../../open-sse/services/runtimeProfile.js";
import { resolveRoutePolicy } from "../../open-sse/services/routePolicy.js";

describe("lmstudio_local resilience", () => {
  it("keeps defaults connection-scoped", () => {
    expect(resolveRuntimeProfileConfig({ runtimeProfile: "standard" })).toEqual({ profile: "standard" });
    expect(resolveRuntimeProfileConfig({ runtimeProfile: "lmstudio_local" }).heartbeat).toEqual({ enabled: true, intervalMs: 15000 });
  });

  it("applies stream policy only to lmstudio_local", () => {
    expect(resolveRoutePolicy("direct", { providerSpecificData: { runtimeProfile: "lmstudio_local" } }).stream.firstByteTimeoutMs).toBe(15000);
    expect(resolveRoutePolicy("direct", { providerSpecificData: { runtimeProfile: "standard" } }).stream.firstByteTimeoutMs).not.toBe(15000);
  });

  it("normalizes mixed text blocks only for lmstudio_local", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] };
    expect(normalizeLmstudioMessages(body, { runtimeProfile: "lmstudio_local" }).messages[0].content).toBe("a\nb");
    expect(normalizeLmstudioMessages(body, { runtimeProfile: "standard" })).toBe(body);
  });
});
