const ROUTE_MODES = new Set(["local", "strong"]);

/** Pure, deterministic model-route classifier. Auto routing is opt-in. */
export function classifyModelRoute(model, options = {}) {
  const requested = typeof model === "string" ? model.trim() : "";
  if (requested && requested !== "auto") {
    return { mode: "explicit", model: requested, fallbackModel: null };
  }
  if (options.auto !== true) {
    return { mode: "strong", model: options.strongModel || "", fallbackModel: null };
  }
  const localModel = typeof options.localModel === "string" ? options.localModel.trim() : "";
  const strongModel = typeof options.strongModel === "string" ? options.strongModel.trim() : "";
  const body = options.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasMedia = JSON.stringify(body).match(/image|audio|video|file/i);
  const hasReasoning = body.reasoning_effort || body.thinking;
  const text = messages.map(message => typeof message?.content === "string" ? message.content : "").join(" ");
  const longContext = text.length > 12000;
  const strong = hasTools || hasMedia || hasReasoning || longContext || /\b(code|debug|plan|implement|analy[sz]e)\b/i.test(text);
  return strong
    ? { mode: "strong", model: strongModel, fallbackModel: null }
    : { mode: "local", model: localModel, fallbackModel: strongModel };
}

export function isAutoRouteFailure(status) {
  const code = Number(status);
  return !Number.isFinite(code) || code >= 500 || code === 408;
}

export { ROUTE_MODES };
