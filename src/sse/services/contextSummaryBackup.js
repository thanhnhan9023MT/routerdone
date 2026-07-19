const DEFAULT_THRESHOLD_TOKENS = 45000;
const MIN_THRESHOLD_TOKENS = 36000;
const MAX_THRESHOLD_TOKENS = Number.MAX_SAFE_INTEGER;

export function normalizeContextBackupConfig(config = {}) {
  const thresholdTokens = Number(config.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS);
  const retainRecentTurns = Number(config.retainRecentTurns ?? 3);
  if (!Number.isInteger(thresholdTokens) || thresholdTokens < MIN_THRESHOLD_TOKENS) {
    throw new Error(`thresholdTokens must be an integer >= ${MIN_THRESHOLD_TOKENS}`);
  }
  if (!Number.isInteger(retainRecentTurns) || retainRecentTurns < 1 || retainRecentTurns > 6) {
    throw new Error("retainRecentTurns must be an integer from 1 to 6");
  }
  return {
    enabled: config.enabled === true,
    thresholdTokens,
    retainRecentTurns,
    codexConnectionId: typeof config.codexConnectionId === "string" ? config.codexConnectionId : "",
    compressModel: typeof config.compressModel === "string" ? config.compressModel.trim().slice(0, 200) : "",
    compressFallbackModel: typeof config.compressFallbackModel === "string" ? config.compressFallbackModel.trim().slice(0, 200) : "",
  };
}

function textOnly(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((x) => x?.type === "text" || x?.type === "input_text" || x?.type === "output_text").map((x) => x.text || "").join("\n");
  return "";
}

function isTextMessage(item) {
  if (!item || typeof item.role !== "string" || !["user", "assistant", "system"].includes(item.role)) return false;
  if (typeof item.content === "string") return true;
  return Array.isArray(item.content) && item.content.every((part) => part && ["text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string");
}

export function isContextBackupEligible(body, { format } = {}) {
  if (!body || body._compact) return false;
  if (body.tools?.length || body.tool_choice || body.parallel_tool_calls || body.include || body.functions?.length || body.function_call) return false;
  if (format === "responses") return Array.isArray(body.input) && body.input.every((item) => item?.type === "message" && isTextMessage(item));
  if (format === "chat" || format === "messages") return Array.isArray(body.messages) && body.messages.every(isTextMessage);
  return false;
}

export function buildContextSummaryBackup(body, { retainRecentTurns = 3, format } = {}) {
  const isResponses = format === "responses" || (!format && Array.isArray(body?.input));
  const key = isResponses ? "input" : "messages";
  const items = Array.isArray(body?.[key]) ? body[key] : [];
  const keep = Math.max(1, retainRecentTurns) * 2;
  if (items.length <= keep) return null;
  const older = items.slice(0, -keep);
  const recent = items.slice(-keep);
  const lines = older.map((item) => `${item.role}: ${textOnly(item.content).replace(/\s+/g, " ").trim()}`).filter((x) => x.replace(/^[^:]+:\s*/, "").trim());
  if (!lines.length) return null;
  const summary = `[RouterDone Context Summary Backup]\n${lines.join("\n")}`;
  const summaryItem = isResponses
    ? { type: "message", role: "system", content: [{ type: "input_text", text: summary }] }
    : { role: "system", content: summary };
  return { ...body, [key]: [summaryItem, ...recent] };
}

export function detectContextBackupFormat(body, pathname = "") {
  if (pathname.endsWith("/responses") || pathname.endsWith("/responses/compact")) return "responses";
  if (pathname.endsWith("/messages")) return "messages";
  if (pathname.endsWith("/chat/completions")) return "chat";
  return Array.isArray(body?.messages) ? "chat" : Array.isArray(body?.input) ? "responses" : null;
}

export const CONTEXT_BACKUP_LIMITS = {
  DEFAULT_THRESHOLD_TOKENS,
  MIN_THRESHOLD_TOKENS,
  MAX_THRESHOLD_TOKENS,
  default: DEFAULT_THRESHOLD_TOKENS,
  min: MIN_THRESHOLD_TOKENS,
  max: MAX_THRESHOLD_TOKENS,
};
