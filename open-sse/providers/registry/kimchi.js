// Kimchi (llm.kimchi.dev) — OpenAI-compatible provider, self-hosted GPU inference.
// NOTE: API lives under the /openai/v1 prefix (NOT /v1). Bearer auth (key format
// `castai_v1_...`). Behind Cloudflare → long requests can 524. Served by the
// DefaultExecutor. Models fetched live from /openai/v1/models (hardcoded as of
// 2026-07-03). Honest model identities (kimi→Moonshot, minimax→MiniMax, deepseek
// →DeepSeek). Some listed models return "no registered providers" (not deployed):
// glm-5.2-fp8 + smollm2-360m confirmed unavailable at add time.
export default {
  id: "kimchi",
  priority: 60,
  alias: "km",
  aliases: ["kimchi"],
  uiAlias: "km",
  display: {
    name: "Kimchi",
    icon: "bolt",
    color: "#F97316",
    textIcon: "KM",
    website: "https://llm.kimchi.dev",
    notice: {
      apiKeyUrl: "https://llm.kimchi.dev",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://llm.kimchi.dev/openai/v1/chat/completions",
    validateUrl: "https://llm.kimchi.dev/openai/v1/models",
    // Force upstream streaming even for non-stream clients: minimax-m3 is a slow
    // reasoning model behind Cloudflare, and long non-stream responses get their
    // connection reset ("terminated"). Streaming keeps the connection alive; the
    // executor aggregates SSE back into a single response for non-stream clients.
    forceStream: true,
  },
  models: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "kimi-k2.7", name: "Kimi K2.7" },
    { id: "minimax-m2.5", name: "MiniMax M2.5" },
    { id: "minimax-m2.7", name: "MiniMax M2.7" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "nemotron-3-super-fp4", name: "Nemotron 3 Super (fp4)" },
    { id: "nemotron-3-ultra-fp4", name: "Nemotron 3 Ultra (fp4)" },
    { id: "qwen3-coder-next-fp8", name: "Qwen3 Coder Next (fp8)" },
    { id: "glm-5.2-fp8", name: "GLM-5.2 (fp8)" },
    { id: "smollm2-135m", name: "SmolLM2 135M" },
    { id: "smollm2-360m", name: "SmolLM2 360M" },
  ],
  modelsFetcher: { url: "https://llm.kimchi.dev/openai/v1/models", type: "openai" },
  serviceKinds: ["llm"],
};
