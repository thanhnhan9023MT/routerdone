/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    // Key by the item's own id when available so multiple items (e.g. a
    // reasoning item + a message item) never collide on a missing/duplicate
    // output_index. Fall back to output_index, then an append counter.
    const item = parsed.item || {};
    const key = item.id || (parsed.output_index != null ? `idx_${parsed.output_index}` : `seq_${state.items.size}`);
    state.items.set(key, item);
  } else if (eventType === "response.output_text.delta") {
    // Accumulate visible answer text as a fallback in case no message item
    // carries the content (some upstreams only stream it via deltas).
    if (typeof parsed.delta === "string") state.textParts.push(parsed.delta);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
    if (parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map(),
    textParts: []
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items, preserving arrival order.
  const output = [...state.items.values()];

  // Ensure there is an assistant message carrying visible text. If the upstream
  // only streamed the answer via output_text.delta (no message item, or a
  // message item with empty content), synthesize/repair one from textParts so
  // downstream converters find the answer instead of only reasoning.
  const streamedText = state.textParts.join("");
  const hasMessageText = output.some((it) =>
    it?.type === "message" && Array.isArray(it.content) &&
    it.content.some((c) => typeof c?.text === "string" && c.text.length > 0)
  );
  if (!hasMessageText && streamedText.length > 0) {
    const existingMsg = output.find((it) => it?.type === "message");
    if (existingMsg) {
      existingMsg.content = [{ type: "output_text", text: streamedText }];
    } else {
      output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: streamedText }] });
    }
  }

  // Never return a fully empty output array.
  if (output.length === 0) {
    output.push({ type: "message", content: [], role: "assistant" });
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output,
    usage: state.usage
  };
}
