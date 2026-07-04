// Sh00t — OpenAI-compatible provider (https://sh00t.host/v1).
// Chat-completions format, API-key auth (Bearer sk_...). Models fetched live
// from /v1/models (also hardcoded below as of 2026-07-03). Served by the
// DefaultExecutor. Carries working GPT/Claude/GLM/Kimi/MiniMax/Qwen/DeepSeek.
export default {
  id: "sh00t",
  priority: 60,
  alias: "sht",
  aliases: ["sh00t", "shoot"],
  uiAlias: "sht",
  display: {
    name: "Sh00t",
    icon: "bolt",
    color: "#EF4444",
    textIcon: "SH",
    website: "https://sh00t.host",
    notice: {
      apiKeyUrl: "https://sh00t.host",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://sh00t.host/v1/chat/completions",
    validateUrl: "https://sh00t.host/v1/models",
  },
  models: [
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4.8-fast", name: "Claude Opus 4.8 Fast" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4.7-fast", name: "Claude Opus 4.7 Fast" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.2-fast", name: "GLM-5.2 (fast)" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "qwen-3.7-plus", name: "Qwen 3.7 Plus" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  ],
  modelsFetcher: { url: "https://sh00t.host/v1/models", type: "openai" },
  serviceKinds: ["llm"],
};
