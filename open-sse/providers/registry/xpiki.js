// Xpiki — OpenAI-compatible provider (https://api.xpiki.com/v1).
// Chat-completions format, API-key auth (Bearer sk-...). Reseller carrying Claude
// via the `kr/` backend (the `dv/` backend has no account and 4xx's, so only the
// verified-working kr/ Claude models are listed). Served by the DefaultExecutor.
export default {
  id: "xpiki",
  priority: 55,
  alias: "xpk",
  aliases: ["xpiki"],
  uiAlias: "xpk",
  display: {
    name: "Xpiki",
    icon: "bolt",
    color: "#8B5CF6",
    textIcon: "XP",
    website: "https://api.xpiki.com",
    notice: {
      apiKeyUrl: "https://api.xpiki.com",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.xpiki.com/v1/chat/completions",
    validateUrl: "https://api.xpiki.com/v1/models",
  },
  models: [
    { id: "kr/claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "kr/claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "kr/claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "kr/claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "kr/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "kr/claude-opus-4.5", name: "Claude Opus 4.5" },
    { id: "kr/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "kr/claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "kr/claude-haiku-4.5", name: "Claude Haiku 4.5" },
  ],
  modelsFetcher: { url: "https://api.xpiki.com/v1/models", type: "openai" },
  serviceKinds: ["llm"],
};
