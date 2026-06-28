import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse OpenAI text-only content-part arrays into a plain string.
// Keep arrays when any non-text block is present so multimodal/tool payloads survive.
export function collapseTextParts(parts) {
  if (!Array.isArray(parts)) return parts;
  if (parts.length > 0 && parts.every((part) => part?.type === OPENAI_BLOCK.TEXT)) {
    return parts.map((part) => part.text || "").join("\n");
  }
  return parts;
}
