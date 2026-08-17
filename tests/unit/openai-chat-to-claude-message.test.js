/**
 * Unit tests for the non-streaming OpenAI chat.completion → Claude Messages
 * response converter (fixes non-stream /v1/messages returning OpenAI JSON).
 */
import { describe, it, expect } from "vitest";
import { openaiChatToClaudeMessage } from "../../open-sse/translator/response/openai-chat-to-claude-message.js";

describe("openaiChatToClaudeMessage", () => {
  it("maps a plain text completion", () => {
    const out = openaiChatToClaudeMessage(
      { id: "cmpl-1", model: "m", choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      "fallback"
    );
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.content).toEqual([{ type: "text", text: "hello" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });

  it("maps tool_calls to tool_use blocks and stop_reason", () => {
    const out = openaiChatToClaudeMessage(
      {
        id: "cmpl-2", model: "m",
        choices: [{
          message: { role: "assistant", content: null, tool_calls: [
            { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"Hanoi"}' } },
            { id: "call_b", type: "function", function: { name: "get_time", arguments: '{"city":"Tokyo"}' } },
          ] },
          finish_reason: "tool_calls",
        }],
      },
      "fallback"
    );
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content).toEqual([
      { type: "tool_use", id: "call_a", name: "get_weather", input: { city: "Hanoi" } },
      { type: "tool_use", id: "call_b", name: "get_time", input: { city: "Tokyo" } },
    ]);
  });

  it("keeps text alongside a tool_use when both present", () => {
    const out = openaiChatToClaudeMessage(
      { choices: [{ message: { content: "let me check", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      "m"
    );
    expect(out.content[0]).toEqual({ type: "text", text: "let me check" });
    expect(out.content[1]).toMatchObject({ type: "tool_use", name: "f", input: {} });
  });

  it("falls back to reasoning text when content is empty and no tools", () => {
    const out = openaiChatToClaudeMessage(
      { choices: [{ message: { content: "", reasoning_content: "thinking..." }, finish_reason: "stop" }] },
      "m"
    );
    expect(out.content).toEqual([{ type: "text", text: "thinking..." }]);
  });

  it("maps length finish_reason to max_tokens and tolerates malformed args", () => {
    const out = openaiChatToClaudeMessage(
      { choices: [{ message: { tool_calls: [{ id: "c", function: { name: "f", arguments: "not-json" } }] }, finish_reason: "length" }] },
      "m"
    );
    expect(out.stop_reason).toBe("max_tokens");
    expect(out.content[0]).toEqual({ type: "tool_use", id: "c", name: "f", input: {} });
  });

  it("always yields at least one content block", () => {
    const out = openaiChatToClaudeMessage({ choices: [{ message: {}, finish_reason: "stop" }] }, "m");
    expect(out.content).toEqual([{ type: "text", text: "" }]);
  });

  // Regression: a Claude-native provider needs no translation, so the body
  // reaching this helper is already a Messages object. Converting it found no
  // `.choices` and returned an empty message with usage 0 — every direct
  // non-stream /v1/messages call to such a provider came back blank.
  it("passes an already-Claude Messages body through untouched", () => {
    const claudeBody = {
      id: "msg_real",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "xin chào" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 7 },
    };
    const out = openaiChatToClaudeMessage(claudeBody, "fallback");
    expect(out).toBe(claudeBody);
    expect(out.content[0].text).toBe("xin chào");
    expect(out.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
  });

  it("passes a Claude tool_use body through untouched", () => {
    const claudeBody = {
      type: "message",
      content: [{ type: "tool_use", id: "toolu_1", name: "fs_write", input: { path: "a" } }],
      usage: { input_tokens: 3, output_tokens: 4 },
    };
    expect(openaiChatToClaudeMessage(claudeBody, "m")).toBe(claudeBody);
  });

  it("still converts an OpenAI body that happens to carry a content array", () => {
    // `type` is absent -> not a Claude Messages body -> must convert normally.
    const out = openaiChatToClaudeMessage(
      { content: [], choices: [{ message: { content: "hi" }, finish_reason: "stop" }] },
      "m"
    );
    expect(out.type).toBe("message");
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
  });

  // An OpenAI Responses message item shares `type:"message"` + `content[]` with
  // Claude and has no `choices`, so the pass-through guard must NOT match it —
  // its blocks are output_text/refusal, not Claude block types.
  it("does not mistake an OpenAI Responses message item for a Claude body", () => {
    const responsesItem = {
      id: "msg_abc",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "hi", annotations: [] }],
    };
    const out = openaiChatToClaudeMessage(responsesItem, "m");
    expect(out).not.toBe(responsesItem);
    expect(out.type).toBe("message");
    expect(Array.isArray(out.content)).toBe(true);
  });

  it("passes a Claude body through even without stop_reason", () => {
    // stop_reason is not part of the discriminator — block types are.
    const claudeBody = { type: "message", content: [{ type: "thinking", thinking: "nghĩ" }] };
    expect(openaiChatToClaudeMessage(claudeBody, "m")).toBe(claudeBody);
  });
});
