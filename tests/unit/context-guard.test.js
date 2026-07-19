import { describe, it, expect } from "vitest";
import { guardContext, formatContextGuardLog, estimateInputTokens, pruneContextToHardCap, formatHardCapPruneLog } from "../../open-sse/rtk/contextGuard.js";
import { countRequestTokens } from "../../open-sse/utils/tokenEstimate.js";

// Build a reasoning item with a sized encrypted_content blob.
function reasoningItem(id, encLen) {
  return {
    type: "reasoning",
    id: `rs_${id}`,
    encrypted_content: "x".repeat(encLen),
    summary: [{ type: "summary_text", text: `reasoning ${id}` }],
  };
}

// Build a body in OpenAI Responses `input` format with N reasoning items.
function makeBody(n, encLen = 2_000) {
  const input = [];
  input.push({ type: "message", role: "user", content: "hello" });
  for (let i = 0; i < n; i++) input.push(reasoningItem(i, encLen));
  input.push({ type: "message", role: "user", content: "next" });
  return { input };
}

describe("guardContext - no-op cases", () => {
  it("returns null when disabled", () => {
    const body = makeBody(10);
    expect(guardContext(body, { enabled: false })).toBeNull();
  });

  // Compact/handoff requests must bypass the guard so the upstream /compact
  // endpoint receives the full reasoning blobs to summarize. chatCore encodes
  // this as `enabled: contextGuardEnabled !== false && !body._compact`.
  it("is skipped for compact/handoff requests (caller disables via !body._compact)", () => {
    const body = makeBody(10); // over default threshold
    body._compact = true;
    // Mirror the exact enabled expression used in chatCore.js
    const enabled = true !== false && !body._compact;
    const stats = guardContext(body, { enabled, maxBytes: 1, keepRecent: 3 });
    expect(stats).toBeNull();
    // All reasoning blobs preserved for upstream compaction
    for (let i = 1; i <= 10; i++) {
      expect(body.input[i].encrypted_content).toBeDefined();
    }
  });
  it("returns null when no items", () => {
    expect(guardContext({ input: [] })).toBeNull();
    expect(guardContext({})).toBeNull();
    expect(guardContext(null)).toBeNull();
  });

  it("returns null when no reasoning items", () => {
    const body = { input: [{ type: "message", role: "user", content: "hi" }] };
    expect(guardContext(body, { maxBytes: 1 })).toBeNull();
  });

  it("returns null when below threshold", () => {
    const body = makeBody(3, 100);
    const stats = guardContext(body, { maxBytes: 3_500_000, keepRecent: 8 });
    expect(stats).toBeNull();
    // nothing mutated
    expect(body.input[1].encrypted_content).toBeDefined();
  });

  it("returns null when keepRecent >= reasoning count (nothing to evict)", () => {
    const body = makeBody(5, 2_000); // 5 reasoning blobs -> over forced threshold
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 5 });
    expect(stats).toBeNull();
    expect(body.input[1].encrypted_content).toBeDefined();
  });
});

describe("guardContext - eviction", () => {
  it("evicts old reasoning blobs keeping the most recent N", () => {
    const body = makeBody(10, 2_000);
    // Use smaller threshold to force eviction with 10 blobs
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 3 });
    expect(stats).not.toBeNull();
    expect(stats.evictedItems).toBe(7); // 10 - 3
    expect(stats.totalReasoningItems).toBe(10);
    expect(stats.keptRecent).toBe(3);
    // oldest 7 evicted (indices 1..7 in input), recent 3 kept (indices 8..10)
    for (let i = 1; i <= 7; i++) {
      expect(body.input[i].encrypted_content).toBeUndefined();
      expect(body.input[i].type).toBe("reasoning"); // structure preserved
      expect(body.input[i].summary).toBeDefined();
    }
    for (let i = 8; i <= 10; i++) {
      expect(body.input[i].encrypted_content).toBeDefined();
    }
  });

  it("replaces empty summary with trim notice on evicted items", () => {
    const body = { input: [] };
    body.input.push({ type: "message", role: "user", content: "hi" });
    // reasoning item without a summary array
    body.input.push({ type: "reasoning", id: "r0", encrypted_content: "x".repeat(2_000) });
    body.input.push({ type: "reasoning", id: "r1", encrypted_content: "x".repeat(2_000) });
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 1 });
    expect(stats.evictedItems).toBe(1);
    expect(body.input[1].encrypted_content).toBeUndefined();
    expect(Array.isArray(body.input[1].summary)).toBe(true);
    expect(body.input[1].summary[0].text).toContain("trimmed");
  });

  it("preserves existing summary on evicted items", () => {
    const body = { input: [] };
    body.input.push({ type: "message", role: "user", content: "hi" });
    body.input.push({
      type: "reasoning",
      id: "r0",
      encrypted_content: "x".repeat(2_000),
      summary: [{ type: "summary_text", text: "custom summary" }],
    });
    body.input.push({ type: "reasoning", id: "r1", encrypted_content: "x".repeat(2_000) });
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 1 });
    expect(stats.evictedItems).toBe(1);
    expect(body.input[1].summary[0].text).toBe("custom summary");
  });

  it("reports estimated token before/after", () => {
    const body = makeBody(10, 2_000);
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 3 });
    expect(stats.estTokensBefore).toBeGreaterThan(0);
    expect(stats.estTokensAfter).toBeGreaterThan(0);
    expect(stats.estTokensBefore).toBeGreaterThan(stats.estTokensAfter);
    expect(stats.evictedBytes).toBeGreaterThan(0);
  });

  it("works with messages-format body", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        reasoningItem(0, 2_000),
        reasoningItem(1, 2_000),
        reasoningItem(2, 2_000),
      ],
    };
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 1 });
    expect(stats.evictedItems).toBe(2);
    expect(body.messages[1].encrypted_content).toBeUndefined();
    expect(body.messages[3].encrypted_content).toBeDefined();
  });

  it("respects custom maxBytes threshold", () => {
    // 3 blobs x 1KB = 3KB; threshold 2.5KB -> evict 1 (keep recent 2)
    const body = makeBody(3, 1_000);
    const stats = guardContext(body, { maxBytes: 2_500, keepRecent: 2 });
    expect(stats).not.toBeNull();
    expect(stats.evictedItems).toBe(1);
    expect(body.input[1].encrypted_content).toBeUndefined();
    expect(body.input[2].encrypted_content).toBeDefined();
    expect(body.input[3].encrypted_content).toBeDefined();
  });
});

describe("formatContextGuardLog", () => {
  it("returns null when no stats", () => {
    expect(formatContextGuardLog(null)).toBeNull();
    expect(formatContextGuardLog({ evictedItems: 0 })).toBeNull();
  });

  it("formats a log line with counts and token estimate", () => {
    const stats = {
      evictedItems: 7,
      totalReasoningItems: 10,
      keptRecent: 3,
      evictedBytes: 1_400_000,
      estBytesBefore: 2_000_000,
      estTokensBefore: 500_000,
      estTokensAfter: 150_000,
      threshold: 1,
    };
    const line = formatContextGuardLog(stats);
    expect(line).toContain("[CTX-GUARD]");
    expect(line).toContain("trimmed 7/10");
    expect(line).toContain("500000 -> 150000 tokens");
    expect(line).toContain("kept recent 3");
  });

  it("includes KB savings from evicted bytes", () => {
    const line = formatContextGuardLog({
      evictedItems: 5,
      totalReasoningItems: 8,
      keptRecent: 3,
      evictedBytes: 2048,
      estBytesBefore: 4096,
      estTokensBefore: 1024,
      estTokensAfter: 512,
    });
    expect(line).toContain("2KB"); // 2048/1024 = 2
  });
});
describe("guardContext - isCompact direct bypass", () => {
  // Covers the internal isCompact option branch directly, distinct from the
  // caller disabling via enabled: ... && !body._compact. chatCore passes
  // isCompact alongside enabled, so both paths must skip eviction.
  it("isCompact: true skips eviction and preserves all encrypted_content", () => {
    const body = makeBody(10, 2_000);
    const stats = guardContext(body, { enabled: true, maxBytes: 1, keepRecent: 3, isCompact: true });
    expect(stats).toBeNull();
    for (let i = 1; i <= 10; i++) {
      expect(body.input[i].encrypted_content).toBeDefined();
    }
  });

  it("isCompact: false with enabled true still evicts (sanity)", () => {
    const body = makeBody(10, 2_000);
    const stats = guardContext(body, { enabled: true, maxBytes: 1, keepRecent: 3, isCompact: false });
    expect(stats).not.toBeNull();
    expect(stats.evictedItems).toBe(7);
  });
});

describe("estimateInputTokens", () => {
  it("returns 0 for null/empty/missing bodies", () => {
    expect(estimateInputTokens(null)).toBe(0);
    expect(estimateInputTokens({})).toBe(0);
    expect(estimateInputTokens({ input: [] })).toBe(0);
    expect(estimateInputTokens({ messages: [] })).toBe(0);
    expect(estimateInputTokens(undefined)).toBe(0);
  });

  it("counts content and encrypted_content", () => {
    const body = makeBody(2, 2_000);
    const tokens = estimateInputTokens(body, "gpt-5");
    expect(tokens).toBe(countRequestTokens(body, "gpt-5").count);
  });

  it("counts array content text parts", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(400) }] },
      ],
    };
    const tokens = estimateInputTokens(body, "gpt-5");
    expect(tokens).toBe(countRequestTokens(body, "gpt-5").count);
  });


  it("counts nested Responses fields like function_call arguments", () => {
    const body = {
      input: [
        { type: "function_call", name: "exec", arguments: "x".repeat(800) },
        { type: "message", content: [{ type: "input_text", text: "y".repeat(400) }] },
      ],
    };
    expect(estimateInputTokens(body, "gpt-5")).toBe(countRequestTokens(body, "gpt-5").count);
  });
  it("counts messages-format body", () => {
    const body = {
      messages: [
        { role: "user", content: "hello world" },
        reasoningItem(0, 800),
      ],
    };
    const tokens = estimateInputTokens(body);
    expect(tokens).toBeGreaterThan(0);
  });
});
describe("pruneContextToHardCap", () => {
  it("trims old large string fields below the hard cap while keeping recent items", () => {
    const body = {
      input: [
        { role: "system", content: "S".repeat(2000) },
        { role: "user", content: "A".repeat(2000) },
        { type: "function_call_output", output: "B".repeat(2000) },
        { role: "assistant", content: "recent assistant" },
        { role: "user", content: "recent user" },
      ],
    };
    const before = estimateInputTokens(body, "gpt-5");
    const hardCapTokens = Math.max(1, Math.floor(before * 0.7));
    const stats = pruneContextToHardCap(body, { hardCapTokens, keepRecent: 2, model: "gpt-5" });
    expect(stats.trimmedStrings).toBeGreaterThan(0);
    expect(stats.estTokensBefore).toBe(before);
    expect(stats.estTokensAfter).toBeLessThan(before);
    expect(body.input[0].content).toBe("S".repeat(2000));
    expect(body.input[1].content).toContain("[trimmed by RouterDone context guard]");
    expect(body.input[3].content).toBe("recent assistant");
    expect(body.input[4].content).toBe("recent user");
  });

  it("preserves Responses and Chat image URLs byte-for-byte", () => {
    const imageUrl = `data:image/png;base64,${"a".repeat(1400)}`;
    for (const body of [
      {
        input: [
          { role: "user", content: [{ type: "input_image", image_url: imageUrl }, { type: "input_text", text: "T".repeat(1800) }] },
          { role: "user", content: "recent" },
        ],
      },
      {
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: imageUrl } }, { type: "text", text: "T".repeat(1800) }] },
          { role: "user", content: "recent" },
        ],
      },
    ]) {
      const items = body.input || body.messages;
      const stats = pruneContextToHardCap(body, { hardCapTokens: 400, keepRecent: 1, model: "gpt-5" });
      expect(stats.trimmedStrings).toBeGreaterThan(0);
      const image = items[0].content[0];
      const actual = typeof image.image_url === "string" ? image.image_url : image.image_url.url;
      expect(actual).toBe(imageUrl);
      expect(items[0].content[1].text).toContain("[trimmed by RouterDone context guard]");
    }
  });

  it("preserves Claude and Gemini inline image payloads", () => {
    const imageData = "a".repeat(1400);
    const bodies = [
      {
        body: {
          messages: [
            { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: imageData } }, { type: "text", text: "T".repeat(1800) }] },
            { role: "user", content: "recent" },
          ],
        },
        image: (body) => body.messages[0].content[0].source.data,
        text: (body) => body.messages[0].content[1].text,
      },
      {
        body: {
          contents: [
            { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: imageData } }, { text: "T".repeat(1800) }] },
            { role: "user", parts: [{ text: "recent" }] },
          ],
        },
        image: (body) => body.contents[0].parts[0].inlineData.data,
        text: (body) => body.contents[0].parts[1].text,
      },
    ];

    for (const { body, image, text } of bodies) {
      const stats = pruneContextToHardCap(body, { hardCapTokens: 400, keepRecent: 1, model: "gpt-5" });
      expect(stats.trimmedStrings).toBeGreaterThan(0);
      expect(image(body)).toBe(imageData);
      expect(text(body)).toContain("[trimmed by RouterDone context guard]");
    }
  });

  it("preserves Ollama raw base64 image arrays", () => {
    const imageData = "a".repeat(1800);
    const body = {
      messages: [
        { role: "user", content: "T".repeat(1800), images: [imageData] },
        { role: "user", content: "recent" },
      ],
    };
    const stats = pruneContextToHardCap(body, { hardCapTokens: 400, keepRecent: 1, model: "gpt-5" });
    expect(stats.trimmedStrings).toBeGreaterThan(0);
    expect(body.messages[0].images[0]).toBe(imageData);
    expect(body.messages[0].content).toContain("[trimmed by RouterDone context guard]");
  });

  it("leaves an image-only request above the cap instead of damaging it", () => {
    const imageUrl = `data:image/png;base64,${"a".repeat(8000)}`;
    const body = {
      input: [
        { role: "user", content: [{ type: "input_image", image_url: imageUrl }] },
        { role: "user", content: "recent" },
      ],
    };
    const hardCapTokens = Math.floor(estimateInputTokens(body, "gpt-5") * 0.5);
    expect(pruneContextToHardCap(body, { hardCapTokens, keepRecent: 1, model: "gpt-5" })).toBeNull();
    expect(body.input[0].content[0].image_url).toBe(imageUrl);
    expect(estimateInputTokens(body, "gpt-5")).toBeGreaterThan(hardCapTokens);
  });

  it("formats hard-cap prune logs", () => {
    const line = formatHardCapPruneLog({ trimmedStrings: 2, savedBytes: 2048, estTokensBefore: 10000, estTokensAfter: 8000, hardCapTokens: 9000 });
    expect(line).toContain("pruned 2 old string fields");
    expect(line).toContain("10000 -> 8000 tokens");
  });
});
