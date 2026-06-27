import { describe, it, expect } from "vitest";
import { shouldForceStreamUpstream } from "../../open-sse/config/runtimeConfig.js";

describe("shouldForceStreamUpstream - custom openai-compatible providers", () => {
  it("forces streaming for the base openai-compatible provider", () => {
    expect(shouldForceStreamUpstream("openai-compatible", "vietapi-model")).toBe(true);
  });

  it("forces streaming for any openai-compatible-* provider (VietAPI fix)", () => {
    expect(
      shouldForceStreamUpstream("openai-compatible-chat-c93ab2fa-45dc-41bc-90d4-43aadb266ddc", "opus-4.6")
    ).toBe(true);
  });

  it("forces streaming for openai-compatible providers regardless of model", () => {
    expect(shouldForceStreamUpstream("openai-compatible-chat-77b8f184", "minimax-m3")).toBe(true);
    expect(shouldForceStreamUpstream("openai-compatible-chat-anything", null)).toBe(true);
  });
});

describe("shouldForceStreamUpstream - existing behavior preserved", () => {
  it("still forces streaming for built-in providers in the set", () => {
    expect(shouldForceStreamUpstream("openai", "gpt-5")).toBe(true);
    expect(shouldForceStreamUpstream("codex", "gpt-5-codex")).toBe(true);
    expect(shouldForceStreamUpstream("commandcode", "any")).toBe(true);
  });

  it("does NOT force streaming for unrelated providers", () => {
    expect(shouldForceStreamUpstream("deepseek", "deepseek-v4-pro")).toBe(false);
    expect(shouldForceStreamUpstream("gemini", "gemini-3.5-flash")).toBe(false);
    expect(shouldForceStreamUpstream("anthropic", "claude-opus-4.8")).toBe(false);
  });

  it("handles non-string provider safely", () => {
    expect(shouldForceStreamUpstream(null, "x")).toBe(false);
    expect(shouldForceStreamUpstream(undefined, undefined)).toBe(false);
  });
});
