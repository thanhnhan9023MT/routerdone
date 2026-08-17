import { fromOpenAIFinish } from "../concerns/finishReason.js";

/**
 * Convert a complete OpenAI `chat.completion` object into a Claude Messages API
 * response object.
 *
 * The streaming path (openai-to-claude.js) already translates provider OpenAI
 * SSE into Claude SSE, but the NON-streaming path returns the raw OpenAI JSON.
 * This is the non-streaming equivalent: used when the client called
 * /v1/messages (source format = claude) but the provider produced OpenAI JSON
 * (e.g. force-stream providers collapsed to JSON, or native OpenAI providers).
 *
 * Only text, reasoning and tool_calls are mapped — the shapes RouterDone's
 * chat pipeline actually emits.
 */
export function openaiChatToClaudeMessage(resp, fallbackModel) {
  const choice = resp?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  } else if (
    typeof msg.reasoning_content === "string" &&
    msg.reasoning_content.length > 0 &&
    !(Array.isArray(msg.tool_calls) && msg.tool_calls.length)
  ) {
    // Content empty but reasoning present (thinking models spent the budget on
    // reasoning) — surface it as text so the answer isn't lost.
    content.push({ type: "text", text: msg.reasoning_content });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tc = msg.tool_calls[i];
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = {}; }
      content.push({
        type: "tool_use",
        id: tc.id || `toolu_${resp?.id || "x"}_${i}`,
        name: tc.function?.name || "",
        input: input && typeof input === "object" ? input : {},
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  const stop_reason = fromOpenAIFinish(choice.finish_reason, "claude");

  return {
    id: resp?.id || `msg_${fallbackModel || "cursor"}`,
    type: "message",
    role: "assistant",
    model: resp?.model || fallbackModel || "unknown",
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: resp?.usage?.prompt_tokens || 0,
      output_tokens: resp?.usage?.completion_tokens || 0,
    },
  };
}
