import { CodexExecutor } from "./codex.js";
import { PROVIDERS } from "../config/providers.js";

/**
 * Codex Sale (Codex backend) executor.
 *
 * codex.sale/backend-api/codex speaks the same OpenAI Responses protocol as the
 * ChatGPT Codex backend, so we reuse the ENTIRE CodexExecutor pipeline
 * (transformRequest / execute / SSE-overloaded retry / parseError). The only
 * differences from `codex`:
 *   - base URL points at codex.sale (from PROVIDERS["codex-sale-codex"].baseUrl)
 *   - auth is an API key, not OAuth — BaseExecutor.buildHeaders already emits
 *     `Authorization: Bearer <apiKey>` when credentials carry apiKey (no accessToken),
 *     so we just disable the OAuth refresh hooks.
 */
export class CodexSaleCodexExecutor extends CodexExecutor {
  constructor() {
    super(); // BaseExecutor("codex", PROVIDERS.codex)
    this.provider = "codex-sale-codex";
    this.config = PROVIDERS["codex-sale-codex"] || this.config;
  }

  // API-key auth: nothing to refresh.
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}
