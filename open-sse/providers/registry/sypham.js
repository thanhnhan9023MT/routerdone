// Sypham (gateqway.sypham9.site) — OpenAI-compatible provider.
// Chat-completions format, API-key auth (Bearer sk-...). Single model GPT-5.5
// (a reasoning model — self-IDs as GPT-5.5/OpenAI; needs adequate max_tokens or
// content comes back empty since reasoning eats the budget). Served by the
// DefaultExecutor. Models fetched live from /v1/models (hardcoded as of 2026-07-03).
export default {
  id: "sypham",
  priority: 60,
  alias: "sy",
  aliases: ["sypham", "gateqway"],
  uiAlias: "sy",
  display: {
    name: "Sypham",
    icon: "bolt",
    color: "#0EA5E9",
    textIcon: "SY",
    website: "https://gateqway.sypham9.site",
    notice: {
      apiKeyUrl: "https://gateqway.sypham9.site",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://gateqway.sypham9.site/v1/chat/completions",
    validateUrl: "https://gateqway.sypham9.site/v1/models",
  },
  models: [
    { id: "GPT-5.5", name: "GPT-5.5" },
  ],
  modelsFetcher: { url: "https://gateqway.sypham9.site/v1/models", type: "openai" },
  serviceKinds: ["llm"],
};
