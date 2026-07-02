// Codex Sale — Codex Responses backend (https://codex.sale/backend-api/codex).
// codex.sale mirrors the ChatGPT Codex backend, so this provider speaks the same
// OpenAI Responses protocol as `codex` but authenticates with an API key instead
// of OAuth. Served by CodexSaleCodexExecutor (subclass of CodexExecutor).
//
// Verified 2026-07-02 against a live codex.sale key: POST /backend-api/codex/responses
// returns a valid Responses SSE stream (response.created/output_text.delta) for gpt-5.5,
// auth = Authorization: Bearer <key>.
export default {
  id: "codex-sale-codex",
  priority: 36,
  alias: "csc",
  aliases: ["codex-sale-codex"],
  uiAlias: "csc",
  display: {
    name: "Codex Sale (Codex)",
    icon: "bolt",
    color: "#10A37F",
    textIcon: "CS",
    website: "https://codex.sale",
    notice: {
      apiKeyUrl: "https://codex.sale",
    },
  },
  category: "apikey",
  authType: "apikey",
  thinkingConfig: {
    options: ["auto", "none", "low", "medium", "high", "xhigh"],
    defaultMode: "auto",
  },
  transport: {
    baseUrl: "https://codex.sale/backend-api/codex/responses",
    format: "openai-responses",
    forceStream: true,
  },
  models: [
    { id: "gpt-5.5", name: "GPT 5.5" },
  ],
  serviceKinds: ["llm"],
};
