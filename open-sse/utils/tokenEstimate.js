const ASCII_CHARS_PER_TOKEN = 4;
const NON_ASCII_CHARS_PER_TOKEN = 1.5;

function estimateStringTokens(value) {
  if (!value) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil((ascii / ASCII_CHARS_PER_TOKEN) + (nonAscii / NON_ASCII_CHARS_PER_TOKEN));
}

export function estimateValueTokens(value, seen = new WeakSet()) {
  if (typeof value === "string") return estimateStringTokens(value);
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);

  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += estimateValueTokens(item, seen);
    return total;
  }

  let total = 0;
  for (const child of Object.values(value)) total += estimateValueTokens(child, seen);
  return total;
}

export function estimateRequestTokens(body) {
  return Math.ceil(estimateValueTokens(body));
}