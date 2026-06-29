import { describe, it, expect } from "vitest";
import { estimateRequestTokens, estimateValueTokens } from "../../open-sse/utils/tokenEstimate.js";

describe("tokenEstimate", () => {
  it("counts nested request fields beyond message text", () => {
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "run", parameters: { query: "x".repeat(4000) } } }],
      metadata: { trace: "y".repeat(2000) },
    };

    expect(estimateRequestTokens(body)).toBeGreaterThan(1400);
  });

  it("counts non-ASCII text more conservatively than ASCII text", () => {
    const ascii = estimateValueTokens("a".repeat(120));
    const vietnamese = estimateValueTokens("ấ".repeat(120));

    expect(vietnamese).toBeGreaterThan(ascii);
  });

  it("handles cycles without throwing", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    body.self = body;

    expect(estimateRequestTokens(body)).toBeGreaterThan(0);
  });
});