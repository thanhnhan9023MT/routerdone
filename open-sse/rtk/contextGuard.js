import { estimateRequestTokens } from "../utils/tokenEstimate.js";

// Context overflow guard: evict old reasoning encrypted_content blobs when the
// request body exceeds a byte-size threshold. Targets the biggest context
// accumulator in long agentic CLI sessions (Codex reasoning items).
//
// Reasoning items in OpenAI Responses format carry an opaque encrypted_content
// blob per turn. Over a long session these accumulate and can push input past
// the model context window. RTK only compresses tool_result content, so this
// guard fills the gap by trimming old reasoning blobs while preserving recent
// ones for continuity.

const DEFAULT_MAX_BYTES = 3_500_000; // byte threshold for oversized request payloads
const DEFAULT_KEEP_RECENT = 8;       // keep last N reasoning items intact
const CHARS_PER_TOKEN = 4;           // byte-prune sizing fallback; not used for token reporting
const TRIM_PLACEHOLDER = "[trimmed by RouterDone context guard]";

// Find the conversation items array across supported request formats.
function findItems(body) {
  if (Array.isArray(body.input)) return body.input;
  if (Array.isArray(body.messages)) return body.messages;
  if (Array.isArray(body.contents)) return body.contents;
  if (Array.isArray(body.request?.contents)) return body.request.contents;
  return null;
}

// Sum sizes of all string leaves across supported request items. This keeps
// CTX-GUARD aligned with provider-side billing for Responses shapes that carry
// large function_call.arguments, nested content, summaries, or metadata fields.
function estimateValueBytes(value, seen = new WeakSet()) {
  if (typeof value === "string") return value.length;
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += estimateValueBytes(item, seen);
    return total;
  }
  let total = 0;
  for (const v of Object.values(value)) total += estimateValueBytes(v, seen);
  return total;
}

function estimateBytes(items) {
  return estimateValueBytes(items);
}
function itemRole(item) {
  if (!item || typeof item !== "object") return "";
  return item.role || (item.type === "message" ? item.role : "");
}

function canTrimItem(item) {
  const role = itemRole(item);
  return role !== "system" && role !== "developer";
}

function trimStringLeaves(value, budget, seen = new WeakSet()) {
  if (budget.saved >= budget.need) return value;
  if (typeof value === "string") {
    if (value.length <= budget.minStringBytes) return value;
    const keep = Math.min(budget.keepChars, Math.max(0, value.length - (budget.need - budget.saved)));
    const next = `${value.slice(0, keep)}\n${TRIM_PLACEHOLDER} (${value.length - keep} chars removed)`;
    if (next.length >= value.length) return value;
    budget.saved += value.length - next.length;
    budget.trimmedStrings++;
    return next;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && budget.saved < budget.need; i++) {
      value[i] = trimStringLeaves(value[i], budget, seen);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    if (budget.saved >= budget.need) break;
    if (key === "id" || key === "role" || key === "type" || key === "name" || key === "call_id" || key === "tool_call_id" || key === "image_url" || key === "url") continue;
    value[key] = trimStringLeaves(value[key], budget, seen);
  }
  return value;
}

// Collect reasoning items that carry an encrypted_content blob.
function collectReasoning(items) {
  const found = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item && item.type === "reasoning" && typeof item.encrypted_content === "string") {
      found.push({ index: i, encLen: item.encrypted_content.length });
    }
  }
  return found;
}

// Evict encrypted_content from old reasoning items, keeping the most recent N
// intact. Preserves the item (type/id/summary/content) so conversation
// structure stays valid; only the heavy blob is removed.
function evictOldReasoning(items, reasoning, keepRecent) {
  const evictCount = reasoning.length - keepRecent;
  if (evictCount <= 0) return null;

  let evictedBytes = 0;
  let evictedItems = 0;
  for (let i = 0; i < evictCount; i++) {
    const { index, encLen } = reasoning[i];
    const item = items[index];
    if (!item) continue;
    delete item.encrypted_content;
    evictedBytes += encLen;
    evictedItems++;
    const hasSummary = Array.isArray(item.summary) && item.summary.length > 0;
    if (!hasSummary) {
      item.summary = [{ type: "summary_text", text: "[reasoning context trimmed to manage conversation length]" }];
    }
  }

  if (evictedItems === 0) return null;
  return { evictedBytes, evictedItems, totalReasoningItems: reasoning.length, keptRecent: Math.min(keepRecent, reasoning.length) };
}

// Public entry. Returns stats object or null when nothing changed.
// isCompact: skip eviction during Codex context-handoff/compaction requests so
// upstream /compact receives full reasoning blobs to summarize.
export function guardContext(body, { enabled = true, maxBytes = DEFAULT_MAX_BYTES, keepRecent = DEFAULT_KEEP_RECENT, isCompact = false, model = body?.model } = {}) {
  if (!enabled || !body || isCompact) return null;

  const items = findItems(body);
  if (!items || items.length === 0) return null;

  const reasoning = collectReasoning(items);
  if (reasoning.length === 0) return null;

  const estBytes = estimateBytes(items);
  if (estBytes < maxBytes) return null;

  const beforeTokens = estimateInputTokens(body, model);
  const result = evictOldReasoning(items, reasoning, keepRecent);
  if (!result) return null;

  return {
    ...result,
    estBytesBefore: estBytes,
    estTokensBefore: beforeTokens,
    estTokensAfter: estimateInputTokens(body, model),
    threshold: maxBytes,
  };
}

// Estimate input token count from the full request body. Reused by chatCore
// for per-request input logging and hard-cap enforcement.
export function estimateInputTokens(body, model = body?.model) {
  if (!body || typeof body !== "object") return 0;
  const items = findItems(body);
  if (!items || items.length === 0) return 0;
  return estimateRequestTokens(body, model);
}

// Format a log line from guard stats.

export function pruneContextToHardCap(body, { enabled = true, hardCapTokens = 0, keepRecent = DEFAULT_KEEP_RECENT, isCompact = false, model = body?.model } = {}) {
  if (!enabled || !body || isCompact || hardCapTokens <= 0) return null;
  const items = findItems(body);
  if (!items || items.length === 0) return null;

  const beforeTokens = estimateInputTokens(body, model);
  if (beforeTokens <= hardCapTokens) return null;

  const targetTokens = Math.max(1, Math.floor(hardCapTokens * 0.95));
  const budget = {
    need: Math.max(0, (beforeTokens - targetTokens) * CHARS_PER_TOKEN),
    saved: 0,
    trimmedStrings: 0,
    minStringBytes: 1024,
    keepChars: 256,
  };
  const lastTrimIndex = Math.max(0, items.length - Math.max(1, keepRecent));
  for (let i = 0; i < lastTrimIndex && budget.saved < budget.need; i++) {
    if (!canTrimItem(items[i])) continue;
    trimStringLeaves(items[i], budget);
  }

  if (budget.trimmedStrings === 0) return null;
  return {
    trimmedStrings: budget.trimmedStrings,
    savedBytes: budget.saved,
    estTokensBefore: beforeTokens,
    estTokensAfter: estimateInputTokens(body, model),
    hardCapTokens,
    targetTokens,
  };
}

export function formatHardCapPruneLog(stats) {
  if (!stats || stats.trimmedStrings === 0) return null;
  const savedKB = Math.round(stats.savedBytes / 1024);
  return `[CTX-GUARD] pruned ${stats.trimmedStrings} old string fields (${savedKB}KB) | est ${stats.estTokensBefore} -> ${stats.estTokensAfter} tokens | cap ${stats.hardCapTokens}`;
}
export function formatContextGuardLog(stats) {
  if (!stats || stats.evictedItems === 0) return null;
  const savedKB = Math.round(stats.evictedBytes / 1024);
  return `[CTX-GUARD] trimmed ${stats.evictedItems}/${stats.totalReasoningItems} reasoning blobs (${savedKB}KB) | est ${stats.estTokensBefore} -> ${stats.estTokensAfter} tokens | kept recent ${stats.keptRecent}`;
}
