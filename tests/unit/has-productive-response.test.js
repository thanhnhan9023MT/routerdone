import { describe, it, expect } from "vitest";
import { hasProductiveResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

// Regression suite for the predicate that gates
// `502 Empty upstream response before content`.
//
// Trước 2026-08-17 nhánh Claude chỉ xét `b.text`, nên một câu trả lời chỉ có
// `tool_use` (mọi request tool-calling tới provider Claude-native) bị coi là
// rỗng và trả 502.
describe("hasProductiveResponse", () => {
  describe("thân Claude Messages", () => {
    it("nhận khối text", () => {
      expect(hasProductiveResponse({ type: "message", content: [{ type: "text", text: "hi" }] })).toBe(true);
    });

    it("nhận câu trả lời CHỈ có tool_use (lỗi cũ trả 502)", () => {
      expect(
        hasProductiveResponse({
          type: "message",
          content: [{ type: "tool_use", id: "toolu_1", name: "fs_write", input: { path: "a.txt" } }],
        })
      ).toBe(true);
    });

    it("nhận server_tool_use", () => {
      expect(
        hasProductiveResponse({ type: "message", content: [{ type: "server_tool_use", id: "s1", name: "web_search" }] })
      ).toBe(true);
    });

    it("nhận câu trả lời chỉ có thinking", () => {
      expect(hasProductiveResponse({ type: "message", content: [{ type: "thinking", thinking: "để tôi nghĩ" }] })).toBe(true);
    });

    it("vẫn coi là RỖNG khi content rỗng", () => {
      expect(hasProductiveResponse({ type: "message", content: [] })).toBe(false);
    });

    it("vẫn coi là RỖNG khi chỉ có khối text trống", () => {
      expect(hasProductiveResponse({ type: "message", content: [{ type: "text", text: "" }] })).toBe(false);
    });

    it("vẫn coi là RỖNG khi thinking trống", () => {
      expect(hasProductiveResponse({ type: "message", content: [{ type: "thinking", thinking: "" }] })).toBe(false);
    });

    // redacted_thinking mang payload ở `.data`, không phải `.thinking`. Guard
    // pass-through ở openai-chat-to-claude-message.js coi nó là khối Claude hợp
    // lệ, nên predicate này phải đồng ý — nếu không body 502 trước khi tới đó.
    it("nhận câu trả lời chỉ có redacted_thinking", () => {
      expect(
        hasProductiveResponse({ type: "message", content: [{ type: "redacted_thinking", data: "ENCRYPTED" }] })
      ).toBe(true);
    });
  });

  describe("không hồi quy các dạng khác", () => {
    it("OpenAI content", () => {
      expect(hasProductiveResponse({ choices: [{ message: { content: "hi" } }] })).toBe(true);
    });

    it("OpenAI tool_calls", () => {
      expect(hasProductiveResponse({ choices: [{ message: { tool_calls: [{ id: "c" }] } }] })).toBe(true);
    });

    it("OpenAI reasoning_content", () => {
      expect(hasProductiveResponse({ choices: [{ message: { reasoning_content: "nghĩ" } }] })).toBe(true);
    });

    it("OpenAI refusal", () => {
      expect(hasProductiveResponse({ choices: [{ message: { refusal: "không thể" } }] })).toBe(true);
    });

    it("OpenAI rỗng vẫn là rỗng", () => {
      expect(hasProductiveResponse({ choices: [{ message: { content: "" } }] })).toBe(false);
    });

    it("null / không phải object", () => {
      expect(hasProductiveResponse(null)).toBe(false);
      expect(hasProductiveResponse("x")).toBe(false);
    });
  });
});
