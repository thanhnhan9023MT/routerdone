/**
 * Vision Preprocessor Service
 *
 * Detects image content in chat requests and preprocesses it through
 * a vision-capable model (e.g. oc/mimo-v2.5-free) BEFORE the chat body
 * reaches a non-vision model. The vision model extracts OCR + brief
 * visual context as text, which replaces the image blocks so the
 * downstream model can understand the image without vision support.
 *
 * Key design:
 *  - Runs once per request, at the handleChat level (before combo dispatch)
 *  - Skips when the target model already supports vision (targetCaps.vision),
 *    including combos whose every member is vision-capable (resolveTargetCaps)
 *  - Only processes images from the LAST user message (new images)
 *  - Images in older messages are stripped without calling vision model
 *  - Uses self-loopback /api/v1/chat/completions for robust routing
 *  - Non-fatal: if vision call fails, original body passes through
 *    and the normal modality-stripping in chatCore handles images
 *  - Vision model NEVER answers user questions -- only reads images
 *  - Reads `content` first, falls back to `reasoning_content` (reasoning
 *    vision models can exhaust output budget and leave content empty)
 */

import { createHash } from "node:crypto";
import { getComboByName } from "@/lib/localDb";

const VISION_MODEL_DEFAULT = "oc/mimo-v2.5-free";

// Parse a positive integer env override, falling back to a default.
// Mirrors the envMs helper in open-sse/config/runtimeConfig.js so these
// ceilings stay tunable from docker-compose without a rebuild.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Bumped 30s -> 60s after 24h of production logs showed mimo-v2.5-free
// consistently takes 15-25s+ to emit an image description (sometimes 30s+),
// and the original 30s ceiling aborted ~62% of calls (10/16). The inline
// comment "mimo is fast (3-8s measured)" below was misleading — it measured
// tiny test images, not real screenshots. 60s gives headroom while still
// bounding a stuck upstream. Env: VISION_TIMEOUT_MS.
const VISION_TIMEOUT_MS = envMs("VISION_TIMEOUT_MS", 60000);
// Reasoning-capable vision models can spend their budget on a thinking pass
// before emitting the description, so give them a longer ceiling (matches the
// combo reasoning stream tier). Used only when the resolved vision model caps
// declare reasoning: true. Env: VISION_REASONING_TIMEOUT_MS.
const VISION_REASONING_TIMEOUT_MS = envMs("VISION_REASONING_TIMEOUT_MS", 60000);
// One retry on a failed/empty vision call. Real-world latency is 15-25s per
// attempt, so a single retry costs up to ~60s before we fall back to a
// placeholder — acceptable since the alternative is no image context at all.
const VISION_MAX_ATTEMPTS = 2;
// Bumped v1 -> v2 when Vision Bridge introduced the UI/UX Design Context
// Override instruction mode + per-request max_tokens budget. Old cache entries
// keyed under v1 are intentionally invalidated so descriptions are regenerated
// with the new instruction/prompt shape.
// Bumped v2 -> v3 when max_tokens budget was added to the cache key — without
// it, raising visionMaxTokens from the Tools tab silently served the old
// short description instead of regenerating a richer one (UI had no effect
// until the 6h TTL expired).
const VISION_INSTRUCTION_VERSION = "v3";
const VISION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const VISION_CACHE_MAX_ENTRIES = 500;

// Default token budget for the vision loopback call. Lets the UI expose a
// "Max Tokens" dropdown (1024 / 2048 / 4096) so heavy screenshots can get a
// richer description instead of being truncated. null/0 = omit max_tokens
// (let the upstream model decide), preserving prior behaviour.
const VISION_MAX_TOKENS_DEFAULT = 1024;
// When the UI/UX Design Context Override is enabled, force a richer budget so
// the design analysis isn't cut short. Always wins over the user-chosen value.
const VISION_MAX_TOKENS_UIUX = 4096;

const VISION_INSTRUCTION = [
  "Ban la cong cu doc anh. Hay doc anh duoi day va cung cap:",
  "1) OCR: Trich xuat toan bo van ban trong anh",
  "2) Mo ta ngan gon: Noi dung chinh cua anh la gi?",
  "",
  "QUAN TRONG: Chi doc anh. KHONG tra loi cau hoi. KHONG phan tich hay binh luan.",
].join("\n");

// UI/UX Design Context Override — richer instruction used when the caller
// opts into the "UI/UX Design Context Override" toggle in the Tools tab.
// Produces a structured UI/UX analysis instead of a plain OCR+caption, so a
// non-vision downstream model can act on a screenshot the way a vision model
// would when designing/refactoring interfaces.
const VISION_INSTRUCTION_UIUX = [
  "Ban la chuyen gia phan tich thiet ke UI/UX. Hay phan tich anh duoi day va cung cap:",
  "1) OCR: Trich xuat toan bo van ban (label, button, menu, placeholder, tab, badge, ...)",
  "2) BOI CANH UI/UX:",
  "   - Loai giao dien (web app, mobile, dashboard, landing, form, table, modal, sidebar, ...)",
  "   - Thanh phan chinh (header, sidebar, card, button, input, table, pagination, ...)",
  "   - Bo cuc & luong diem (grid, columns, navigation flow, huong doc)",
  "   - Mau sac chu dao & phong cach (dark/light, primary/secondary/accent, density)",
  "   - Trang thai thanh phan (active, disabled, hover, error, loading, selected)",
  "3) DE XUAT NGAN GON: 2-3 diem can thiet neu ap dung vao he thong cua minh",
  "",
  "QUAN TRONG: Chi phan tich anh giao dien. KHONG tra loi cau hoi khac. KHONG binh luan ngoai pham vi UI/UX.",
].join("\n");

// ── In-memory vision description cache ──────────────────────────────────────────
const visionDescriptionCache = new Map();
const visionDescriptionCacheStats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

function nowMs() { return Date.now(); }

function pruneExpiredVisionCache(now = nowMs()) {
  for (const [key, entry] of visionDescriptionCache) {
    if (!entry || entry.expiresAt <= now) {
      visionDescriptionCache.delete(key);
      visionDescriptionCacheStats.evictions += 1;
    }
  }
}

function enforceVisionCacheLimit() {
  while (visionDescriptionCache.size > VISION_CACHE_MAX_ENTRIES) {
    const oldestKey = visionDescriptionCache.keys().next().value;
    if (!oldestKey) return;
    visionDescriptionCache.delete(oldestKey);
    visionDescriptionCacheStats.evictions += 1;
  }
}

export function clearVisionDescriptionCache() {
  visionDescriptionCache.clear();
  visionDescriptionCacheStats.hits = 0;
  visionDescriptionCacheStats.misses = 0;
  visionDescriptionCacheStats.sets = 0;
  visionDescriptionCacheStats.evictions = 0;
}

export function getVisionDescriptionCacheStats() {
  pruneExpiredVisionCache();
  return {
    size: visionDescriptionCache.size,
    hits: visionDescriptionCacheStats.hits,
    misses: visionDescriptionCacheStats.misses,
    sets: visionDescriptionCacheStats.sets,
    evictions: visionDescriptionCacheStats.evictions,
    ttlMs: VISION_CACHE_TTL_MS,
    maxEntries: VISION_CACHE_MAX_ENTRIES,
  };
}

// ── Image hashing and cache key helpers ─────────────────────────────────────────

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function imageUrlFromBlock(block) {
  if (block?.type !== "image_url") return null;
  return typeof block.image_url === "string" ? block.image_url : block.image_url?.url || null;
}

function hashImageUrl(url) {
  if (!url || typeof url !== "string") return null;
  const dataMatch = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (dataMatch) {
    const mime = (dataMatch[1] || "application/octet-stream").toLowerCase();
    const isBase64 = !!dataMatch[2];
    const payload = dataMatch[3] || "";
    const bytes = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    return mime + ":" + sha256Hex(bytes);
  }
  return "url:" + sha256Hex(url);
}

function buildVisionCacheKey(visionModel, imageBlocks, instructionMode, maxTokens) {
  const imageHashes = [];
  for (const block of imageBlocks || []) {
    const url = imageUrlFromBlock(block);
    const hash = hashImageUrl(url);
    if (!hash) return null;
    imageHashes.push(hash);
  }
  if (imageHashes.length === 0) return null;
  // instructionMode distinguishes standard OCR+caption descriptions from
  // UI/UX design-context descriptions, so toggling the override regenerates
  // with the right prompt instead of serving the wrong cached text.
  const mode = instructionMode === "uiux" ? "uiux" : "standard";
  // maxTokens is part of the key so raising the budget from the Tools tab
  // invalidates the old short description and regenerates a richer one —
  // without this the UI dropdown had no effect until the 6h TTL expired.
  // (UI/UX override forces 4096, so its key is stable for a given image.)
  const budget = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0;
  return [
    "vision-description",
    VISION_INSTRUCTION_VERSION,
    mode,
    visionModel || VISION_MODEL_DEFAULT,
    String(budget),
    ...imageHashes,
  ].join("|");
}

function getCachedVisionDescription(cacheKey) {
  if (!cacheKey) return null;
  pruneExpiredVisionCache();
  const entry = visionDescriptionCache.get(cacheKey);
  if (!entry) {
    visionDescriptionCacheStats.misses += 1;
    return null;
  }
  // LRU: re-insert at end
  visionDescriptionCache.delete(cacheKey);
  visionDescriptionCache.set(cacheKey, entry);
  visionDescriptionCacheStats.hits += 1;
  return entry.text;
}

function setCachedVisionDescription(cacheKey, text) {
  if (!cacheKey || !text || !text.trim()) return;
  visionDescriptionCache.set(cacheKey, {
    text,
    createdAt: nowMs(),
    expiresAt: nowMs() + VISION_CACHE_TTL_MS,
  });
  visionDescriptionCacheStats.sets += 1;
  enforceVisionCacheLimit();
}

// ── Core functions ──────────────────────────────────────────────────────────────

export function hasImageContent(body) {
  if (!body?.messages) return false;
  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "image_url" || block?.type === "image") return true;
    }
  }
  return false;
}

async function fetchImageAsBase64(url) {
  if (url.startsWith("data:")) return url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "RouterDone/1.0" },
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.log("[VISION] Fetch failed: " + response.status + " for " + url.slice(0, 80));
      return null;
    }
    const contentType = response.headers.get("content-type") || "";
    const buffer = await response.arrayBuffer();
    let mime = contentType.split(";")[0].trim();
    if (!mime || !mime.startsWith("image/")) {
      if (url.match(/\.jpe?g$/i)) mime = "image/jpeg";
      else if (url.match(/\.png$/i)) mime = "image/png";
      else if (url.match(/\.gif$/i)) mime = "image/gif";
      else if (url.match(/\.webp$/i)) mime = "image/webp";
      else mime = "image/png";
    }
    const base64 = Buffer.from(buffer).toString("base64");
    return "data:" + mime + ";base64," + base64;
  } catch (fetchErr) {
    console.log("[VISION] Fetch error for " + url.slice(0, 80) + ": " + fetchErr.message);
    return null;
  }
}

async function extractImagesFromMessage(msg, log) {
  const imageBlocks = [];
  if (!Array.isArray(msg.content)) return imageBlocks;
  for (const block of msg.content) {
    if (block?.type === "image_url") {
      const url = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
      if (!url) continue;
      if (url.startsWith("http://") || url.startsWith("https://")) {
        log?.info?.("VISION", "Prefetching remote image: " + url.slice(0, 80));
        const base64Url = await fetchImageAsBase64(url);
        if (base64Url) {
          imageBlocks.push({ type: "image_url", image_url: { url: base64Url } });
        } else {
          log?.warn?.("VISION", "Failed to prefetch image: " + url.slice(0, 80));
        }
      } else {
        imageBlocks.push({ type: "image_url", image_url: { url } });
      }
    } else if (block?.type === "image") {
      const src = block.source;
      if (src?.type === "base64" && src?.media_type && src?.data) {
        imageBlocks.push({ type: "image_url", image_url: { url: "data:" + src.media_type + ";base64," + src.data } });
      } else if (src?.type === "url" && src?.url) {
        const base64Url = await fetchImageAsBase64(src.url);
        if (base64Url) {
          imageBlocks.push({ type: "image_url", image_url: { url: base64Url } });
        }
      }
    }
  }
  return imageBlocks;
}

function buildVisionRequestFromImages(imageBlocks, instructionMode, maxTokens) {
  if (!imageBlocks?.length) return null;
  const instruction = instructionMode === "uiux" ? VISION_INSTRUCTION_UIUX : VISION_INSTRUCTION;
  const request = {
    // Use streaming for vision loopback. Heavy image prompts can take long enough
    // that non-streaming providers/proxies time out before the first byte.
    stream: true,
    model: "",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: instruction },
        ...imageBlocks,
      ],
    }],
  };
  // Inject max_tokens budget when provided. UI/UX override always forces the
  // richer VISION_MAX_TOKENS_UIUX so the design analysis isn't truncated.
  const budget = instructionMode === "uiux"
    ? VISION_MAX_TOKENS_UIUX
    : (Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null);
  if (budget) request.max_tokens = budget;
  return request;
}

function parseVisionSSEToOpenAIResponse(rawSSE, fallbackModel) {
  const contentParts = [];
  const reasoningParts = [];
  let id = null;
  let created = null;
  let model = fallbackModel;
  let finishReason = "stop";
  let usage = null;

  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    try {
      const chunk = JSON.parse(payload);
      id ||= chunk.id;
      created ||= chunk.created;
      model ||= chunk.model;
      if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

      const choice = chunk?.choices?.[0];
      const delta = choice?.delta || {};
      if (typeof delta.content === "string") contentParts.push(delta.content);
      if (typeof delta.reasoning_content === "string") reasoningParts.push(delta.reasoning_content);
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    } catch {
      // Ignore malformed SSE lines and keep parsing later chunks.
    }
  }

  if (contentParts.length === 0 && reasoningParts.length === 0) return null;

  const message = { role: "assistant", content: contentParts.join("") };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");

  const result = {
    id: id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) result.usage = usage;
  return result;
}

async function readVisionResponse(response, visionModel) {
  const contentType = response.headers?.get?.("content-type") || "";
  const shouldParseAsSSE = contentType.includes("text/event-stream");

  if (shouldParseAsSSE) {
    const rawSSE = await response.text();
    return parseVisionSSEToOpenAIResponse(rawSSE, visionModel);
  }

  // Some adapters may accept stream:true but still normalize the upstream stream
  // back to JSON. Keep this fallback so vision preprocessing works with both.
  return response.json();
}

// Extract the vision model's textual description from its chat completion
// response. Prefer `content`; fall back to `reasoning_content` because some
// reasoning-capable vision models (e.g. mimo-v2.5-free) can exhaust their
// output budget on reasoning and leave `content` empty, in which case the
// reasoning trace still carries the image description.
export function extractVisionText(data) {
  const msg = data?.choices?.[0]?.message;
  if (!msg) return null;
  const content = typeof msg.content === "string" ? msg.content : null;
  const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : null;
  return content || reasoning || null;
}

// Resolve the *target* model's vision capability for a model string that may be
// either a direct `provider/model` or a combo name. Returns `{ vision: true }`
// only when EVERY model the request can route to already supports vision
// natively — in that case preprocessing would only downgrade quality (replace a
// raw image with a text description). Returns null otherwise (mixed / non-vision
// / unknown) so preprocessing runs and gives non-vision fallback members usable
// text context instead of a raw image they cannot read.
//
// `deps` is injected so this stays unit-testable without a DB:
//   { getModelInfo, getComboModels, getCapabilitiesForModel }
export async function resolveTargetCaps(modelStr, deps) {
  const { getModelInfo, getComboModels, getCapabilitiesForModel } = deps;

  // Direct provider/model — resolve caps straight away.
  const info = await getModelInfo(modelStr);
  if (info?.provider) {
    return getCapabilitiesForModel(info.provider, info.model);
  }

  // Combo — skip preprocessing only if ALL members are vision-capable.
  // If any member lacks vision, preprocessing must run so that member still
  // receives a text description instead of being fed a raw image it can't read.
  const members = await getComboModels(modelStr);
  if (!members || members.length === 0) return null;

  for (const m of members) {
    const mInfo = await getModelInfo(m);
    if (!mInfo?.provider) {
      // Nested combo / unknown member — be safe, don't skip.
      return null;
    }
    const caps = getCapabilitiesForModel(mInfo.provider, mInfo.model);
    if (caps?.vision !== true) {
      return null;
    }
  }
  return { vision: true };
}

// Resolve capabilities for the first member of a combo. Used by the defer
// path to decide whether to skip eager preprocessing (vision-first combo).
// `deps`: { getModelInfo, getComboModels, getCapabilitiesForModel }
export async function resolveFirstComboMemberCaps(modelStr, deps) {
  const { getModelInfo, getComboModels, getCapabilitiesForModel } = deps;
  const members = await getComboModels(modelStr);
  if (!members || members.length === 0) return null;
  const firstInfo = await getModelInfo(members[0]);
  if (!firstInfo?.provider) return null;
  return getCapabilitiesForModel(firstInfo.provider, firstInfo.model);
}

// Decide whether to defer vision preprocessing for a combo. Returns true when
// AT LEAST ONE member is vision-capable — handleComboChat's auto-switch will
// float a vision model to the front, so the happy path can feed the raw image
// directly and only preprocess lazily if a non-vision fallback is actually
// tried. Returns false for all-text combos (must eager-preprocess) and for
// direct (non-combo) models (resolveTargetCaps handles those).
export async function shouldDeferComboVisionPreprocessing(modelStr, deps) {
  const { getModelInfo, getComboModels, getCapabilitiesForModel } = deps;
  const members = await getComboModels(modelStr);
  if (!members || members.length === 0) return false;
  for (const m of members) {
    const mInfo = await getModelInfo(m);
    if (mInfo?.provider) {
      const caps = getCapabilitiesForModel(mInfo.provider, mInfo.model);
      if (caps?.vision === true) return true;
    }
  }
  return false;
}

function stripImagesFromMessage(msg, placeholder) {
  if (!Array.isArray(msg.content)) return msg;
  const filtered = msg.content.filter(b => b?.type !== "image_url" && b?.type !== "image");
  const trimmed = filtered.filter(b => !(b?.type === "text" && !b.text?.trim()));
  if (placeholder) {
    trimmed.push({ type: "text", text: placeholder });
  }
  return { ...msg, content: trimmed };
}

// Perform the vision loopback call once. Returns { ok, data } on a usable
// response, or { ok:false } on HTTP error / timeout / parse failure so the
// caller can decide whether to retry.
async function callVisionOnce(apiUrl, visionBody, timeoutMs, authKey, visionModel, log) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "Content-Type": "application/json" };
    // Forward an API key so the loopback survives deployments with
    // requireApiKey=true. Without this, an enabled auth gate turns every image
    // request into a silent 401 -> placeholder. Default RouterDone keys are
    // unrestricted, so reusing the caller's key is safe for routing.
    if (authKey) headers.Authorization = "Bearer " + authKey;
    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(visionBody),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      log?.warn?.("VISION", "Vision model HTTP " + response.status + ": " + errText.slice(0, 200));
      return { ok: false };
    }
    const data = await readVisionResponse(response, visionModel);
    const text = extractVisionText(data);
    if (!text || !text.trim()) {
      log?.warn?.("VISION", "Vision model returned empty content");
      return { ok: false };
    }
    return { ok: true, text };
  } catch (error) {
    if (error.name === "AbortError") {
      log?.warn?.("VISION", "Vision request timed out after " + timeoutMs + "ms");
    } else {
      log?.warn?.("VISION", "Vision fetch error: " + error.message);
    }
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

export async function preprocessVisionContent(body, settings, log, targetCaps, opts = {}) {
  if (!hasImageContent(body)) return null;

  // Skip if the *target* model already supports vision natively — preprocessing
  // would only downgrade quality (replace a raw image with a text description).
  // targetCaps is resolved by the caller (chat.js) via getCapabilitiesForModel.
  if (targetCaps?.vision === true) {
    log?.info?.("VISION", "Target model has vision capability, skipping preprocessing");
    return null;
  }

  // Prevent infinite loop: skip if this is already a vision loopback request
  if (body._skipVision) {
    return null;
  }

  if (settings?.visionPreprocessingEnabled === false) {
    log?.info?.("VISION", "Vision preprocessing disabled by settings");
    return null;
  }

  let visionModel = settings?.visionPreprocessingModel || VISION_MODEL_DEFAULT;

  // "combo:<name>" resolves to the first model in the named combo, so the
  // user can manage the vision model from the Combos tab without touching
  // Tools. Falls back to VISION_MODEL_DEFAULT if the combo is missing or empty.
  if (visionModel.startsWith("combo:")) {
    const comboName = visionModel.slice("combo:".length);
    try {
      const combo = await getComboByName(comboName);
      const models = combo?.models;
      if (Array.isArray(models) && models.length > 0 && models[0].includes("/")) {
        log?.info?.("VISION", "Resolved combo:" + comboName + " → " + models[0]);
        visionModel = models[0];
      } else {
        log?.warn?.("VISION", "Combo '" + comboName + "' has no valid models, falling back to " + VISION_MODEL_DEFAULT);
        visionModel = VISION_MODEL_DEFAULT;
      }
    } catch (err) {
      log?.warn?.("VISION", "Failed to resolve combo '" + comboName + "': " + err.message);
      visionModel = VISION_MODEL_DEFAULT;
    }
  }

  if (!visionModel.includes("/")) {
    log?.warn?.("VISION", "Invalid vision model string: " + visionModel);
    return null;
  }

  // Vision Bridge: choose instruction mode + token budget from settings.
  // uiUxOverride swaps the OCR+caption prompt for a structured UI/UX design
  // analysis and forces a richer max_tokens budget (4096). maxTokens only
  // applies to the standard instruction mode; the override always wins.
  const uiUxOverride = settings?.visionUiUxOverride === true;
  const instructionMode = uiUxOverride ? "uiux" : "standard";
  const rawMaxTokens = Number(settings?.visionMaxTokens);
  const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : VISION_MAX_TOKENS_DEFAULT;

  // Skip if target model IS the vision model (it can handle images natively)
  const visionModelId = visionModel.split("/").slice(1).join("/");
  if (body.model === visionModel || body.model === visionModelId) {
    log?.info?.("VISION", "Target model is vision model, skipping preprocessing");
    return null;
  }

  const messages = body.messages || [];

  // Find the LAST user message index
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) {
    log?.warn?.("VISION", "No user message found");
    return null;
  }

  // Older messages: don't blindly discard their images. If an image was OCR'd
  // in a previous turn its description is already cached (keyed by image content
  // hash), so restore that text instead of dropping the context. Only fall back
  // to a bare strip on a cache miss — we never make a vision call for old images.
  let strippedCount = 0;
  let restoredCount = 0;
  for (let mi = 0; mi < messages.length; mi++) {
    if (mi === lastUserIdx) continue;
    const msg = messages[mi];
    if (!Array.isArray(msg.content)) continue;
    const hasImgs = msg.content.some(b => b?.type === "image_url" || b?.type === "image");
    if (!hasImgs) continue;

    let restored = false;
    try {
      const oldBlocks = await extractImagesFromMessage(msg, log);
      if (oldBlocks.length) {
        const oldKey = buildVisionCacheKey(visionModel, oldBlocks, instructionMode, maxTokens);
        const oldCached = getCachedVisionDescription(oldKey);
        if (oldCached) {
          messages[mi] = stripImagesFromMessage(msg, "[Image description: " + oldCached + "]");
          restoredCount++;
          restored = true;
        }
      }
    } catch (e) {
      log?.warn?.("VISION", "Old-image cache lookup failed (non-fatal): " + e.message);
    }
    if (!restored) {
      messages[mi] = stripImagesFromMessage(msg);
      strippedCount++;
    }
  }
  if (restoredCount > 0) {
    log?.info?.("VISION", "Restored cached description for " + restoredCount + " older message(s)");
  }
  if (strippedCount > 0) {
    log?.info?.("VISION", "Stripped images from " + strippedCount + " older message(s)");
  }

  // Process images in the LAST user message only
  const lastMsg = messages[lastUserIdx];
  const lastMsgImages = lastMsg.content?.filter(b => b?.type === "image_url" || b?.type === "image") || [];

  if (lastMsgImages.length === 0) {
    return strippedCount > 0 ? body : null;
  }

  log?.info?.("VISION", "Processing " + lastMsgImages.length + " image(s) in last user message");

  // Extract image blocks and build cache key
  const imageBlocks = await extractImagesFromMessage(lastMsg, log);
  if (!imageBlocks.length) {
    log?.warn?.("VISION", "No valid images to preprocess");
    return null;
  }

  const cacheKey = buildVisionCacheKey(visionModel, imageBlocks, instructionMode, maxTokens);
  const cachedVisionText = getCachedVisionDescription(cacheKey);
  if (cachedVisionText) {
    messages[lastUserIdx] = stripImagesFromMessage(lastMsg, "[Image description: " + cachedVisionText + "]");
    log?.info?.("VISION", "Using cached image description (" + cachedVisionText.length + " chars)");
    return body;
  }

  const visionBody = buildVisionRequestFromImages(imageBlocks, instructionMode, maxTokens);
  if (!visionBody) {
    log?.warn?.("VISION", "No valid images to preprocess");
    return null;
  }
  visionBody.model = visionModel;

  // Mark request to prevent infinite vision loopback recursion
  visionBody._skipVision = true;

  // Call vision model via self-loopback
  const port = process.env.PORT || 20128;
  const apiUrl = "http://127.0.0.1:" + port + "/api/v1/chat/completions";

  // Dynamic timeout: reasoning-capable vision models get a longer ceiling.
  const visionCaps = opts.visionCaps || null;
  const timeoutMs = visionCaps?.reasoning === true ? VISION_REASONING_TIMEOUT_MS : VISION_TIMEOUT_MS;
  const authKey = opts.apiKey || null;

  log?.info?.("VISION", "Calling vision model " + visionModel + " via self-loopback (timeout=" + timeoutMs + "ms)");

  // Try once, then retry once on failure/empty before giving up to a placeholder.
  let visionText = null;
  for (let attempt = 1; attempt <= VISION_MAX_ATTEMPTS; attempt++) {
    const res = await callVisionOnce(apiUrl, visionBody, timeoutMs, authKey, visionModel, log);
    if (res.ok) { visionText = res.text; break; }
    if (attempt < VISION_MAX_ATTEMPTS) {
      log?.info?.("VISION", "Retry vision call (attempt " + (attempt + 1) + "/" + VISION_MAX_ATTEMPTS + ")");
    }
  }

  if (!visionText) {
    messages[lastUserIdx] = stripImagesFromMessage(lastMsg, "[Image -- vision model failed to describe]");
    return body;
  }

  setCachedVisionDescription(cacheKey, visionText);
  log?.info?.("VISION", "Got " + visionText.length + " chars from vision model");
  messages[lastUserIdx] = stripImagesFromMessage(lastMsg, "[Image description: " + visionText + "]");
  log?.info?.("VISION", "Images replaced with description in last message");
  return body;
}
