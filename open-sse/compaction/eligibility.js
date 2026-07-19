const MIN_THRESHOLD_TOKENS = 36_000;
const DEFAULT_THRESHOLD_TOKENS = 45_000;
const MAX_THRESHOLD_TOKENS = Number.MAX_SAFE_INTEGER;

export function resolveContextBackupConfig(config = {}, contextWindowTokens = 0) {
  const requested = Number(config.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS);
  const safeRequested = Number.isInteger(requested) ? requested : DEFAULT_THRESHOLD_TOKENS;
  return {
    enabled: config.enabled === true,
    thresholdTokens: Math.max(MIN_THRESHOLD_TOKENS, safeRequested),
    retainRecentTurns: Math.min(6, Math.max(1, Number.isInteger(Number(config.retainRecentTurns)) ? Number(config.retainRecentTurns) : 3)),
    codexConnectionId: typeof config.codexConnectionId === "string" ? config.codexConnectionId : "",
  };
}

export function isContextBackupEligible({ body, sourceFormat, provider, comboHasCodex = false, estimatedTokens = 0, config, contextWindowTokens = 0 } = {}) {
  const resolved = resolveContextBackupConfig(config, contextWindowTokens);
  if (!resolved.enabled) return { eligible: false, reason: "disabled", config: resolved };
  if (sourceFormat !== "openai-responses") return { eligible: false, reason: "source_format", config: resolved };
  if (estimatedTokens < resolved.thresholdTokens) return { eligible: false, reason: "below_threshold", config: resolved };
  if (!body || body.previous_response_id || body.conversation || body.store === true || body.background === true) {
    return { eligible: false, reason: "stateful_request", config: resolved };
  }
  const serialized = JSON.stringify(body.input || "");
  if (/input_image|input_file|input_audio|function_call|function_call_output|computer_use|web_search/i.test(serialized)) {
    return { eligible: false, reason: "unsupported_content", config: resolved };
  }
  return { eligible: true, reason: "eligible", config: resolved };
}

export const CONTEXT_BACKUP_LIMITS = Object.freeze({
  min: MIN_THRESHOLD_TOKENS,
  default: DEFAULT_THRESHOLD_TOKENS,
  max: MAX_THRESHOLD_TOKENS,
});
