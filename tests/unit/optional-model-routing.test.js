import { describe, expect, it } from "vitest";
import { classifyModelRoute, isAutoRouteFailure } from "../../open-sse/services/modelRouting.js";

describe("optional local-vs-strong routing", () => {
  it("preserves explicit models and combos", () => {
    expect(classifyModelRoute("aidone-local", { auto: true, localModel: "local", strongModel: "strong" }).mode).toBe("explicit");
    expect(classifyModelRoute("my-combo", { auto: true, localModel: "local", strongModel: "strong" }).model).toBe("my-combo");
  });
  it("keeps auto disabled by default", () => {
    expect(classifyModelRoute("auto", { localModel: "local", strongModel: "strong" }).mode).toBe("strong");
  });
  it("classifies plain short text local, complex work strong", () => {
    expect(classifyModelRoute("auto", { auto: true, body: { messages: [{ content: "hello" }] }, localModel: "local", strongModel: "strong" }).mode).toBe("local");
    expect(classifyModelRoute("auto", { auto: true, body: { tools: [{}], messages: [{ content: "debug this" }] }, localModel: "local", strongModel: "strong" }).mode).toBe("strong");
  });
  it("marks only timeout/5xx as local fallback", () => {
    expect(isAutoRouteFailure(408)).toBe(true);
    expect(isAutoRouteFailure(503)).toBe(true);
    expect(isAutoRouteFailure(400)).toBe(false);
  });
});
