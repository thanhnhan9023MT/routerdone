// NeuralWatt — OpenAI-compatible provider (https://api.neuralwatt.com/v1).
// Chat-completions format, API-key auth. Models fetched live from /v1/models
// (also hardcoded below as of 2026-07-02). Served by the DefaultExecutor.
export default {
  id: "neuralwatt",
  priority: 60,
  alias: "nw",
  aliases: ["neuralwatt"],
  uiAlias: "nw",
  display: {
    name: "NeuralWatt",
    icon: "bolt",
    color: "#22C55E",
    textIcon: "NW",
    website: "https://neuralwatt.com",
    notice: {
      apiKeyUrl: "https://neuralwatt.com",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.neuralwatt.com/v1/chat/completions",
    validateUrl: "https://api.neuralwatt.com/v1/models",
  },
  models: [
    { id: "qwen3.6-35b", name: "Qwen3.6 35B" },
    { id: "qwen3.6-35b-fast", name: "Qwen3.6 35B Fast" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.2-fast", name: "GLM-5.2 (fast)" },
    { id: "glm-5.2-short", name: "GLM-5.2 (short)" },
    { id: "glm-5.2-short-fast", name: "GLM-5.2 (short, fast)" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "qwen3.5-397b", name: "Qwen3.5 397B" },
    { id: "qwen3.5-397b-fast", name: "Qwen3.5 397B Fast" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "kimi-k2.6-fast", name: "Kimi K2.6 Fast" },
  ],
  modelsFetcher: { url: "https://api.neuralwatt.com/v1/models", type: "openai" },
  serviceKinds: ["llm"],
};
