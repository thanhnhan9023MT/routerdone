export default {
  id: "cursor-agent",
  priority: 41,
  alias: "ca",
  uiAlias: "ca",
  display: {
    name: "Cursor Agent (CLI)",
    icon: "terminal",
    color: "#000000",
    textIcon: "CA",
    website: "https://cursor.com/cli",
    notice:
      "Runs the local `cursor-agent` binary in read-only ask mode. Requires the CLI installed (curl https://cursor.com/install | bash) and a Cursor API key (crsr_...). Single-user / self-host only.",
  },
  category: "apikey",
  transport: {
    // No HTTP baseUrl — this provider shells out to the local CLI.
    baseUrl: "",
    format: "openai",
    // Emit SSE always; downstream collapses to JSON for non-stream clients.
    forceStream: true,
  },
  // Accept any model id the CLI supports (the catalog changes over time).
  passthroughModels: true,
  // Curated shortlist, strongest first (Claude, then GPT). All ids verified on
  // the account 2026-07-20. passthroughModels:true means any other id from the
  // full catalog still works when typed — this list only orders the dropdown.
  // Use plain/explicit ids — the interactive bracket form
  // (e.g. claude-opus-4-8[context=1m,...]) is rejected in headless --print mode.
  models: [
    // — Claude (strongest first) —
    { id: "claude-opus-4-8-max", name: "Opus 4.8 Max" },
    { id: "claude-opus-4-8-thinking-max", name: "Opus 4.8 Thinking Max" },
    { id: "claude-opus-4-8-high", name: "Opus 4.8 High" },
    { id: "claude-opus-4-8-thinking-high", name: "Opus 4.8 Thinking High" },
    { id: "claude-sonnet-5-max", name: "Sonnet 5 Max" },
    { id: "claude-sonnet-5-thinking-high", name: "Sonnet 5 Thinking High" },
    { id: "claude-sonnet-5-high", name: "Sonnet 5 High" },
    { id: "claude-opus-4-7-max", name: "Opus 4.7 Max" },
    { id: "claude-4.6-opus-max", name: "Opus 4.6 Max" },
    { id: "claude-4.5-opus-high", name: "Opus 4.5 High" },
    { id: "claude-4.5-sonnet", name: "Sonnet 4.5 (fast)" },
    { id: "claude-fable-5-max", name: "Fable 5 Max" },
    { id: "claude-fable-5-thinking-max", name: "Fable 5 Thinking Max" },
    { id: "claude-fable-5-high", name: "Fable 5 High" },
    // — GPT (strongest first) —
    { id: "gpt-5.6-sol-max", name: "GPT-5.6 Sol Max" },
    { id: "gpt-5.6-sol-high", name: "GPT-5.6 Sol High" },
    { id: "gpt-5.6-luna-max", name: "GPT-5.6 Luna Max" },
    { id: "gpt-5.6-terra-max", name: "GPT-5.6 Terra Max" },
    { id: "gpt-5.5-extra-high", name: "GPT-5.5 Extra High" },
    { id: "gpt-5.5-high", name: "GPT-5.5 High" },
    { id: "gpt-5.3-codex-high", name: "GPT-5.3 Codex High" },
    { id: "gpt-5.1-codex-max-high", name: "GPT-5.1 Codex Max High" },
    { id: "gpt-5.2-high", name: "GPT-5.2 High" },
    { id: "gpt-5.1-high", name: "GPT-5.1 High" },
    { id: "gpt-5-mini", name: "GPT-5 Mini (fast)" },
    // — Others —
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "auto", name: "Auto (Cursor picks)" },
  ],
};
