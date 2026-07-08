// Strip multimodal content blocks a model cannot read, BEFORE translation.
// Driven by getCapabilitiesForModel: vision/audioInput/pdf. Replaces removed
// media with a short text placeholder so messages never become empty.
import { FORMATS } from "../formats.js";

// Placeholder text inserted where a media block was removed.
// Current turn: explain the active model can't read what the user just sent.
const PLACEHOLDER_CURRENT = {
  vision: "[image omitted: model has no vision support]",
  audioInput: "[audio omitted: model has no audio support]",
  pdf: "[file omitted: model has no document support]",
};
// Earlier turns: neutral (a combo may route to a different model each turn).
const PLACEHOLDER_PREV = {
  vision: "[Previous image omitted from context.]",
  audioInput: "[Previous audio omitted from context.]",
  pdf: "[Previous file omitted from context.]",
};
const ph = (cap, isLast) => (isLast ? PLACEHOLDER_CURRENT : PLACEHOLDER_PREV)[cap];
const invalidImagePh = (isLast) =>
  isLast ? "[image omitted: invalid image data]" : "[Previous image omitted from context: invalid image data.]";

// Map gemini inlineData/fileData mime prefix -> capability it requires.
function capForMime(mime) {
  if (typeof mime !== "string") return null;
  if (mime.startsWith("image/")) return "vision";
  if (mime.startsWith("audio/")) return "audioInput";
  if (mime === "application/pdf") return "pdf";
  return null;
}

// OpenAI chat content block -> required capability (null = plain text/other, keep).
function capForOpenAIBlock(block) {
  const t = block?.type;
  if (t === "image_url" || t === "image") return "vision";
  if (t === "input_audio" || t === "audio_url") return "audioInput";
  if (t === "file") return "pdf";
  return null;
}

function isImageDataUrl(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match || match[1].length === 0 || match[1].length % 4 === 1) return false;
  try {
    return Buffer.from(match[1], "base64").length > 0;
  } catch {
    return false;
  }
}

function isImageUrl(value) {
  return isImageDataUrl(value) || /^https?:\/\/\S+$/i.test(value);
}

function hasInvalidResponsesOutputImageUrl(body) {
  return Array.isArray(body?.input) && body.input.some((item) =>
    Array.isArray(item?.output) && item.output.some((b) =>
      Object.hasOwn(b || {}, "image_url") && !isImageUrl(b.image_url)
    )
  );
}

function isResponsesFormat(sourceFormat) {
  return sourceFormat === FORMATS.OPENAI_RESPONSES ||
    sourceFormat === FORMATS.OPENAI_RESPONSE ||
    sourceFormat === FORMATS.CODEX;
}

// Claude content block -> required capability.
function capForClaudeBlock(block) {
  const t = block?.type;
  if (t === "image") return "vision";
  if (t === "document") return "pdf";
  return null;
}

// Filter an array of content blocks; drop unsupported, inject one placeholder per kind.
// isLast = block belongs to the current user turn (picks the explanatory placeholder).
function filterBlocks(blocks, capOf, caps, removed, isLast) {
  const out = [];
  for (const block of blocks) {
    const cap = capOf(block);
    if (cap && caps[cap] === false) { removed.add(cap); continue; }
    out.push(block);
  }
  for (const cap of removed) out.push({ type: "text", text: ph(cap, isLast) });
  return out;
}

// OpenAI / OpenAI-compatible chat messages[].content[].
function stripOpenAI(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages.forEach((msg, i) => {
    if (!Array.isArray(msg.content)) return;
    const removed = new Set();
    msg.content = filterBlocks(msg.content, capForOpenAIBlock, caps, removed, i === last);
  });
}

// Claude messages[].content[].
function stripClaude(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages.forEach((msg, i) => {
    if (!Array.isArray(msg.content)) return;
    const removed = new Set();
    msg.content = filterBlocks(msg.content, capForClaudeBlock, caps, removed, i === last);
  });
}

// OpenAI Responses input[].content[] (input_image / input_file).
function stripResponses(body, caps) {
  if (!Array.isArray(body.input)) return;
  const last = body.input.length - 1;
  body.input.forEach((item, i) => {
    if (Array.isArray(item.content)) {
      const removed = new Set();
      item.content = item.content.filter((b) => {
        const cap = b?.type === "input_image" ? "vision" : b?.type === "input_file" ? "pdf" : null;
        if (cap && caps[cap] === false) { removed.add(cap); return false; }
        return true;
      });
      for (const cap of removed) item.content.push({ type: "input_text", text: ph(cap, i === last) });
    }

    if (Array.isArray(item.output)) {
      const removed = new Set();
      let removedInvalidImage = false;
      item.output = item.output.filter((b) => {
        const isImage = b?.type === "input_image" || Object.hasOwn(b || {}, "image_url");
        if (!isImage) return true;
        if (caps.vision === false) { removed.add("vision"); return false; }
        if (!isImageUrl(b.image_url)) { removedInvalidImage = true; return false; }
        return true;
      });
      for (const cap of removed) item.output.push({ type: "output_text", text: ph(cap, i === last) });
      if (removedInvalidImage) item.output.push({ type: "output_text", text: invalidImagePh(i === last) });
    }
  });
}

// Gemini / gemini-cli contents[].parts[] (inlineData / fileData by mime).
function stripGeminiParts(contents, caps) {
  if (!Array.isArray(contents)) return;
  const last = contents.length - 1;
  contents.forEach((c, i) => {
    if (!Array.isArray(c.parts)) return;
    const removed = new Set();
    c.parts = c.parts.filter((p) => {
      const mime = p?.inlineData?.mimeType || p?.fileData?.mimeType;
      const cap = capForMime(mime);
      if (cap && caps[cap] === false) { removed.add(cap); return false; }
      return true;
    });
    for (const cap of removed) c.parts.push({ text: ph(cap, i === last) });
  });
}

/**
 * Remove media blocks the model can't read, in-place on the source-format body.
 * @param {object} body - request body (source format)
 * @param {string} sourceFormat - one of FORMATS
 * @param {object} caps - capabilities from getCapabilitiesForModel
 * @returns {boolean} true if anything was stripped-eligible (cap false for some modality)
 */
export function stripUnsupportedModalities(body, sourceFormat, caps) {
  if (!body || !caps) return false;
  // Fast exit: model supports everything we'd strip.
  if (
    caps.vision !== false &&
    caps.audioInput !== false &&
    caps.pdf !== false &&
    !(isResponsesFormat(sourceFormat) && hasInvalidResponsesOutputImageUrl(body))
  ) return false;

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      stripOpenAI(body, caps);
      break;
    case FORMATS.CLAUDE:
      stripClaude(body, caps);
      break;
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      stripResponses(body, caps);
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      stripGeminiParts(body.contents, caps);
      break;
    case FORMATS.ANTIGRAVITY:
      stripGeminiParts(body?.request?.contents, caps);
      break;
    default:
      stripOpenAI(body, caps);
  }
  return true;
}
