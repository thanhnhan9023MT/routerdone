import { encodingForModel, getEncoding, getEncodingNameForModel } from "js-tiktoken";

const FALLBACK_CONFIDENCE = 0.82;
const FALLBACK_ASCII_CHARS_PER_TOKEN = 4;
const FALLBACK_NON_ASCII_CHARS_PER_TOKEN = 1.5;

const tokenizerCache = new Map();

const OPENAI_COMPATIBLE_ENCODINGS = [
  { pattern: /^(gpt-5|gpt-4o|gpt-4\.1|codex)/i, tokenizer: "o200k_base" },
  { pattern: /^(gpt-4|gpt-3\.5|text-embedding-3|text-embedding-ada)/i, tokenizer: "cl100k_base" },
];

function normalizeModel(model) {
  return typeof model === "string" ? model.trim() : "";
}

function isUnsupportedProviderModel(model) {
  return /^(claude|anthropic|gemini|deepseek|glm|qwen)\b/i.test(model);
}

function manualOpenAICompatibleTokenizer(model) {
  for (const { pattern, tokenizer } of OPENAI_COMPATIBLE_ENCODINGS) {
    if (pattern.test(model)) return tokenizer;
  }
  return null;
}

function getCachedEncoding(tokenizer) {
  if (!tokenizerCache.has(tokenizer)) {
    tokenizerCache.set(tokenizer, getEncoding(tokenizer));
  }
  return tokenizerCache.get(tokenizer);
}

export function resolveTokenizer(model) {
  const normalized = normalizeModel(model);
  if (!normalized || isUnsupportedProviderModel(normalized)) return null;

  try {
    const tokenizer = getEncodingNameForModel(normalized);
    if (tokenizer) return { tokenizer, encoding: getCachedEncoding(tokenizer) };
  } catch {}

  try {
    const encoding = encodingForModel(normalized);
    const tokenizer = manualOpenAICompatibleTokenizer(normalized) || normalized;
    return { tokenizer, encoding };
  } catch {}

  const tokenizer = manualOpenAICompatibleTokenizer(normalized);
  if (!tokenizer) return null;
  return { tokenizer, encoding: getCachedEncoding(tokenizer) };
}

function estimateStringTokens(value) {
  if (!value) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil((ascii / FALLBACK_ASCII_CHARS_PER_TOKEN) + (nonAscii / FALLBACK_NON_ASCII_CHARS_PER_TOKEN));
}

function collectScalarText(value, parts, seen) {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    parts.push(String(value));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectScalarText(item, parts, seen);
    return;
  }

  for (const child of Object.values(value)) collectScalarText(child, parts, seen);
}

function valueToText(value) {
  if (typeof value === "string") return value;
  const parts = [];
  collectScalarText(value, parts, new WeakSet());
  return parts.join("\n");
}

function estimatedResult(text) {
  return {
    count: estimateStringTokens(text),
    mode: "estimated",
    tokenizer: "fallback",
    confidence: FALLBACK_CONFIDENCE,
  };
}

function exactResult(text, resolved) {
  return {
    count: resolved.encoding.encode(text).length,
    mode: "exact",
    tokenizer: resolved.tokenizer,
  };
}

export function countTextTokens(text, model) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const resolved = resolveTokenizer(model);
  if (!resolved) return estimatedResult(value);
  return exactResult(value, resolved);
}

export function countTextTokensBatch(texts, model) {
  const values = Array.isArray(texts) ? texts : [texts];
  const resolved = resolveTokenizer(model);
  return values.map((text) => {
    const value = typeof text === "string" ? text : String(text ?? "");
    return resolved ? exactResult(value, resolved) : estimatedResult(value);
  });
}

export function countValueTokens(value, model) {
  return countTextTokens(valueToText(value), model);
}

export function countRequestTokens(body, model = body?.model) {
  return countValueTokens(body, model);
}

export function estimateValueTokens(value, model) {
  return countValueTokens(value, model).count;
}

export function estimateRequestTokens(body, model = body?.model) {
  return countRequestTokens(body, model).count;
}
