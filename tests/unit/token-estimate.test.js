import { describe, it, expect } from "vitest";
import { getEncoding } from "js-tiktoken";
import {
  countRequestTokens,
  countTextTokens,
  countTextTokensBatch,
  countValueTokens,
  estimateRequestTokens,
  estimateValueTokens,
  resolveTokenizer,
} from "../../open-sse/utils/tokenEstimate.js";

const o200k = getEncoding("o200k_base");

const exactCases = [
  ["English", "The quick brown fox jumps over the lazy dog."],
  ["Vietnamese", "Xin chào, RouterDone đang đếm token chính xác."],
  ["Chinese", "这是一个中文分词测试。"],
  ["Japanese", "これは日本語のトークン化テストです。"],
  ["Korean", "이것은 한국어 토큰화 테스트입니다."],
  ["Emoji", "Build passed ✅🚀🔥"],
  ["Markdown", "# Title\n\n- item **bold**\n- `code`"],
  ["JSON", JSON.stringify({ model: "gpt-5", ok: true, n: 123 })],
  ["XML", "<root><item id=\"1\">hello</item></root>"],
  ["HTML", "<main><h1>Hello</h1><p>RouterDone</p></main>"],
  ["SQL", "SELECT id, name FROM users WHERE active = true ORDER BY created_at DESC;"],
  ["Source Code", "function add(a, b) {\n  return a + b;\n}\nconsole.log(add(1, 2));"],
  ["Long Context", "RouterDone exact token counter ".repeat(1000)],
  ["Mixed Languages", "Hello Việt Nam こんにちは 世界 😀 SELECT * FROM logs;"],
];

describe("tokenEstimate", () => {
  it.each(exactCases)("counts %s exactly with o200k_base", (_name, text) => {
    const result = countTextTokens(text, "gpt-5");
    expect(result).toEqual({
      count: o200k.encode(text).length,
      mode: "exact",
      tokenizer: "o200k_base",
    });
  });

  it("uses official model resolution before manual fallback", () => {
    const result = countTextTokens("hello", "gpt-4o");
    expect(result.mode).toBe("exact");
    expect(result.tokenizer).toBe("o200k_base");
    expect(result.count).toBe(o200k.encode("hello").length);
  });

  it("uses manual OpenAI-compatible fallback for Codex model names", () => {
    const result = countTextTokens("hello codex", "codex-mini-latest");
    expect(result.mode).toBe("exact");
    expect(result.tokenizer).toBe("o200k_base");
    expect(result.count).toBe(o200k.encode("hello codex").length);
  });

  it("counts batches without changing exact metadata", () => {
    const texts = ["hello", "Xin chào", "😀"];
    const results = countTextTokensBatch(texts, "gpt-5-mini");
    expect(results).toHaveLength(texts.length);
    for (let i = 0; i < texts.length; i++) {
      expect(results[i]).toEqual({
        count: o200k.encode(texts[i]).length,
        mode: "exact",
        tokenizer: "o200k_base",
      });
    }
  });

  it("counts nested request scalar values with exact tokenizer", () => {
    const body = {
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "run", parameters: { query: "Xin chào" } } }],
      metadata: { trace: "abc123" },
    };
    const joined = "gpt-5\nuser\nhello\nfunction\nrun\nXin chào\nabc123";
    const result = countRequestTokens(body, "gpt-5");
    expect(result).toEqual({
      count: o200k.encode(joined).length,
      mode: "exact",
      tokenizer: "o200k_base",
    });
  });

  it("handles cycles without throwing", () => {
    const body = { model: "gpt-5", messages: [{ role: "user", content: "hello" }] };
    body.self = body;

    expect(countRequestTokens(body, "gpt-5").count).toBeGreaterThan(0);
  });

  it("falls back to estimated mode when official tokenizer is unavailable", () => {
    const result = countTextTokens("hello qwen", "qwen2.5-coder");
    expect(result.mode).toBe("estimated");
    expect(result.tokenizer).toBe("fallback");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.count).toBeGreaterThan(0);
  });

  it("keeps legacy numeric wrappers", () => {
    expect(estimateValueTokens("hello", "gpt-5")).toBe(o200k.encode("hello").length);
    expect(estimateRequestTokens({ model: "gpt-5", input: "hello" }, "gpt-5")).toBeGreaterThan(0);
  });

  it("does not resolve unsupported provider tokenizers as exact", () => {
    expect(resolveTokenizer("claude-3-5-sonnet-20241022")).toBeNull();
    expect(resolveTokenizer("gemini-2.5-pro")).toBeNull();
    expect(resolveTokenizer("deepseek-chat")).toBeNull();
    expect(resolveTokenizer("glm-4.5")).toBeNull();
    expect(resolveTokenizer("qwen3-coder")).toBeNull();
  });

  it("counts object values via countValueTokens", () => {
    const result = countValueTokens({ a: "hello", b: 42, c: false }, "gpt-5");
    expect(result.count).toBe(o200k.encode("hello\n42\nfalse").length);
    expect(result.mode).toBe("exact");
  });
});
