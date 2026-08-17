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
const OMITTED_IMAGE_PLACEHOLDER = "[image omitted by RouterDone context guard]";
const OMITTED_AUDIO_PLACEHOLDER = "[audio omitted by RouterDone context guard]";

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

function isMediaBlock(value) {
  if (!value || typeof value !== "object") return false;
  const type = value.type;
  if (["image_url", "image", "input_image", "audio_url", "input_audio"].includes(type)) return true;
  if (value.image_url && typeof value.image_url === "object") return true;
  if (typeof value.image_url === "string") return true;
  if (value.audio_url && typeof value.audio_url === "object") return true;
  if (typeof value.audio_url === "string") return true;
  return false;
}

function mediaPlaceholderBlock(value) {
  const type = value?.type || "";
  const isAudio = type.includes("audio") || value?.audio_url;
  const text = isAudio ? OMITTED_AUDIO_PLACEHOLDER : OMITTED_IMAGE_PLACEHOLDER;
  return { type: type.startsWith("input_") ? "input_text" : "text", text };
}

function containsTrimPlaceholder(value, seen = new WeakSet()) {
  if (typeof value === "string") return value.includes(TRIM_PLACEHOLDER);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsTrimPlaceholder(item, seen));
  return Object.values(value).some((item) => containsTrimPlaceholder(item, seen));
}

function sanitizeTrimmedMediaValue(value, stats, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (isMediaBlock(item) && containsTrimPlaceholder(item)) {
        const next = mediaPlaceholderBlock(item);
        stats.sanitizedMediaBlocks++;
        stats.savedBytes += Math.max(0, estimateValueBytes(item) - estimateValueBytes(next));
        value[i] = next;
        continue;
      }
      value[i] = sanitizeTrimmedMediaValue(item, stats, seen);
    }
    return value;
  }

  if (isMediaBlock(value)) return value;

  for (const key of Object.keys(value)) {
    value[key] = sanitizeTrimmedMediaValue(value[key], stats, seen);
  }
  return value;
}

export function sanitizeTrimmedMediaBlocks(body) {
  if (!body || typeof body !== "object") return null;
  const items = findItems(body);
  if (!items || items.length === 0) return null;
  const stats = { sanitizedMediaBlocks: 0, savedBytes: 0 };
  sanitizeTrimmedMediaValue(items, stats);
  return stats.sanitizedMediaBlocks > 0 ? stats : null;
}


function isImageMediaObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = String(value.type || "").toLowerCase();
  if (type === "image" || type === "image_url" || type === "input_image" || type === "output_image") return true;
  const mime = value.mimeType || value.mime_type || value.media_type;
  return typeof mime === "string" && mime.toLowerCase().startsWith("image/");
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
  if (!value || typeof value !== "object" || isImageMediaObject(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  // Never recurse into media payloads. Trimming a data URL in-place creates an
  // invalid image/audio block that some upstream token counters reject before
  // generation (observed as VietAPI count_token_failed on gpt-5.5).
  if (isMediaBlock(value)) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && budget.saved < budget.need; i++) {
      value[i] = trimStringLeaves(value[i], budget, seen);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    if (budget.saved >= budget.need) break;
    if (key === "id" || key === "role" || key === "type" || key === "name" || key === "call_id" || key === "tool_call_id" || key === "image_url" || key === "url" || key === "images") continue;
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
    trimmedMediaBlocks: 0,
    minStringBytes: 1024,
    keepChars: 256,
  };
  const lastTrimIndex = Math.max(0, items.length - Math.max(1, keepRecent));
  // KHÔNG chạy bước "thay media của item cũ bằng placeholder" mà upstream v0.5.16x thêm
  // (replaceOldMediaBlocks). Nó phá 3 đảm bảo đã có của fork — đo 2026-08-17: 3 test
  // media ĐANG XANH ở fork (28/28) chuyển sang ĐỎ ngay khi nhận bước đó:
  //   preserves Responses and Chat image URLs byte-for-byte
  //   preserves Claude and Gemini inline image payloads
  //   leaves an image-only request above the cap instead of damaging it
  // Hợp đồng của fork là: THÀ để request vượt trần (chatCore trả context_too_large 400)
  // còn hơn gửi lên một khối ảnh đã bị sửa. Lý do không phải khẩu vị: media bị cắt/thay
  // làm upstream đếm token thất bại TRƯỚC khi sinh (đã thấy VietAPI count_token_failed
  // trên gpt-5.5) — hỏng nặng hơn và khó truy hơn là một lỗi 400 nói thẳng.
  // Phần media CÒN LẠI của upstream vẫn giữ: isMediaBlock / mediaPlaceholderBlock /
  // sanitizeTrimmedMediaBlocks (đường CỨU media đã bị build cũ cắt) vẫn được dùng.
  for (let i = 0; i < lastTrimIndex && budget.saved < budget.need; i++) {
    if (!canTrimItem(items[i])) continue;
    trimStringLeaves(items[i], budget);
  }

  if (budget.trimmedStrings === 0 && budget.trimmedMediaBlocks === 0) return null;
  return {
    trimmedStrings: budget.trimmedStrings,
    trimmedMediaBlocks: budget.trimmedMediaBlocks,
    savedBytes: budget.saved,
    estTokensBefore: beforeTokens,
    estTokensAfter: estimateInputTokens(body, model),
    hardCapTokens,
    targetTokens,
  };
}

export function formatHardCapPruneLog(stats) {
  if (!stats || (stats.trimmedStrings === 0 && stats.trimmedMediaBlocks === 0)) return null;
  const savedKB = Math.round(stats.savedBytes / 1024);
  const parts = [];
  if (stats.trimmedStrings) parts.push(`${stats.trimmedStrings} old string fields`);
  if (stats.trimmedMediaBlocks) parts.push(`${stats.trimmedMediaBlocks} old media blocks`);
  return `[CTX-GUARD] pruned ${parts.join(" + ")} (${savedKB}KB) | est ${stats.estTokensBefore} -> ${stats.estTokensAfter} tokens | cap ${stats.hardCapTokens}`;
}
export function formatContextGuardLog(stats) {
  if (!stats || stats.evictedItems === 0) return null;
  const savedKB = Math.round(stats.evictedBytes / 1024);
  return `[CTX-GUARD] trimmed ${stats.evictedItems}/${stats.totalReasoningItems} reasoning blobs (${savedKB}KB) | est ${stats.estTokensBefore} -> ${stats.estTokensAfter} tokens | kept recent ${stats.keptRecent}`;
}
