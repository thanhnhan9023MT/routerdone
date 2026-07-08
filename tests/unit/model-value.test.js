import { describe, expect, it } from "vitest";
import { normalizeLiveModelValue } from "@/shared/utils/modelValue.js";

describe("live model value normalization", () => {
  it("prefixes compatible-provider native model IDs that contain slashes", () => {
    expect(normalizeLiveModelValue("z-ai/glm-5.2", "nv", { forceAliasPrefix: true })).toBe("nv/z-ai/glm-5.2");
  });

  it("does not double-prefix already-prefixed compatible model IDs", () => {
    expect(normalizeLiveModelValue("nv/z-ai/glm-5.2", "nv", { forceAliasPrefix: true })).toBe("nv/z-ai/glm-5.2");
  });

  it("keeps existing non-compatible slash behavior by default", () => {
    expect(normalizeLiveModelValue("openai/gpt-4o", "openai")).toBe("openai/gpt-4o");
    expect(normalizeLiveModelValue("gpt-4o", "openai")).toBe("openai/gpt-4o");
  });
});
