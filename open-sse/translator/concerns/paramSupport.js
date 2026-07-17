import { getCapabilitiesForModel } from "../../providers/capabilities.js";

// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
// Config-driven: add a rule instead of scattering `delete body.x` across executors.

// Each rule: optional provider, regex match on model, list of params to drop.
// A param is removed only when it is present (!== undefined).
const STRIP_RULES = [
  // claude-opus-4 series: temperature is deprecated (Anthropic 400). #1748
  { match: /claude-opus-4/i, drop: ["temperature"] },
  // GitHub Copilot gpt-5.4: temperature unsupported.
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },
  // GitHub Copilot Claude (except opus/sonnet 4.6): thinking + reasoning_effort rejected. #713
  { provider: "github", match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4\.6/i.test(m), drop: ["thinking", "reasoning_effort"] },
  // Cloudflare Workers AI: content must be plain string, rejects OpenAI content-part array (#1926)
  { provider: "cloudflare-ai", flattenContent: true },
  { provider: "volcengine-ark", match: /glm-5/i, clampToModelMaxOutput: true },
  // xAI grok models reject presence_penalty/frequency_penalty upstream
  // (400 invalid-argument: "Model grok-… does not support parameter presencePenalty").
  { provider: "xai", match: /grok/i, drop: ["presence_penalty", "frequency_penalty"] },
];

// Strict upstreams (Fireworks-style, e.g. EuroModels) reject with HTTP 400 "Extra
// inputs are not permitted, field: 'X'" for ANY request field outside their schema
// (GPT-5.x extras like verbosity/text, or stream_options on a non-stream request).
// GoCinema/PremiumShop accept them. Opt-in PER PROVIDER ID — to fix another strict
// provider, add its provider id (this.provider / connection `provider`) with the
// fields it rejects.
const STRICT_PROVIDER_DROP = {
  // EuroModels (euromodels.xyz):
  "openai-compatible-chat-45f27de6-ba0c-4662-b05a-03d0af28255f": {
    drop: ["verbosity", "text"],               // 400 "Extra inputs not permitted"
    dropWhenNotStreaming: ["stream_options"],  // only invalid when stream !== true
  },
};

// Drop the fields a strict provider rejects. `drop` is removed whenever present;
// `dropWhenNotStreaming` is removed only when the request is not actually streaming
// (so stream_options survives real streams for usage). Reusable via STRICT_PROVIDER_DROP.
function stripStrictProviderParams(provider, body) {
  const rule = STRICT_PROVIDER_DROP[provider];
  if (!rule) return;
  for (const key of rule.drop || []) {
    if (body[key] !== undefined) delete body[key];
  }
  if (body.stream !== true) {
    for (const key of rule.dropWhenNotStreaming || []) {
      if (body[key] !== undefined) delete body[key];
    }
  }
}

// Reasoning models spend their token budget on hidden thinking BEFORE any visible
// content. On a strict passthrough upstream (Fireworks-style, e.g. EuroModels) a low
// client max_tokens is honored literally → thinking eats the whole budget →
// finish_reason:"length" with EMPTY content. The combo layer already guards its members
// (services/combo.js applyComboReasoningFloor); this is the same floor for the DIRECT
// (non-combo) passthrough path, so raw euro/<reasoning-model> at low max_tokens no
// longer returns empty. Opt-in PER PROVIDER ID (regex on model). Idempotent: combo
// requests arrive already raised (>= floor) → no-op; and it only ever raises a
// present-but-too-low value up, never lowers a user's larger budget.
const MAX_TOKENS_FLOOR = 24576; // == services/combo.js COMBO_REASONING_ALLOWANCE
const MAX_OUTPUT_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
const MAX_TOKENS_FLOOR_PROVIDERS = {
  // EuroModels (euromodels.xyz) — reasoning models empty at low max_tokens.
  "openai-compatible-chat-45f27de6-ba0c-4662-b05a-03d0af28255f":
    /glm|kimi|deepseek|minimax|qwen|claude|sonnet|opus|haiku|fable/i,
};

function raiseMaxTokensFloor(provider, model, body) {
  const modelRe = MAX_TOKENS_FLOOR_PROVIDERS[provider];
  if (!modelRe || !modelRe.test(String(model || ""))) return;
  for (const key of MAX_OUTPUT_FIELDS) {
    const v = body[key];
    if (typeof v === "number" && Number.isInteger(v) && v > 0 && v < MAX_TOKENS_FLOOR) {
      body[key] = MAX_TOKENS_FLOOR;
    }
  }
}

// Test a rule's match (regex or predicate) against the model id.
function matches(rule, model) {
  if (!rule.match) return true;
  return typeof rule.match === "function" ? rule.match(model) : rule.match.test(model);
}

function clampNumber(body, key, ceiling) {
  if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] > ceiling) {
    body[key] = ceiling;
  }
}

// Remove unsupported params from body in place; returns body.
export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;
  stripStrictProviderParams(provider, body);
  raiseMaxTokensFloor(provider, model, body);
  for (const rule of STRIP_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (!matches(rule, model)) continue;
    for (const key of rule.drop || []) {
      if (body[key] !== undefined) delete body[key];
    }
    // CF Workers AI oneOf root schema only accepts content as plain string (#1926)
    if (rule.flattenContent && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg && Array.isArray(msg.content)) {
          msg.content = msg.content
            .map(b => (b?.type === "text" && typeof b.text === "string") ? b.text : "")
            .join("");
        }
      }
    }
    if (rule.clampToModelMaxOutput) {
      const ceiling = getCapabilitiesForModel(provider, model).maxOutput;
      if (Number.isFinite(ceiling) && ceiling > 0) {
        clampNumber(body, "max_tokens", ceiling);
        clampNumber(body, "max_completion_tokens", ceiling);
        clampNumber(body, "max_output_tokens", ceiling);
      }
    }
  }
  return body;
}
