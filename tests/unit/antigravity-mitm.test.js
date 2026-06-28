import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";

// config.js is the CJS MITM bundle module (dependency-isolated for the runtime copy).
const require = createRequire(import.meta.url);
const { MODEL_NO_MAP } = require("../../src/mitm/config.js");
const { intercept } = require("../../src/mitm/handlers/antigravity.js");
afterEach(() => {
  vi.restoreAllMocks();
});

async function captureForwardedBody(inputBody) {
  const chunks = [];
  const res = {
    headersSent: false,
    writeHead: vi.fn(function () { this.headersSent = true; }),
    write: vi.fn((chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))),
    end: vi.fn((chunk) => { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); }),
  };

  let forwardedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url, init) => {
    forwardedBody = JSON.parse(init.body);
    return new Response("data: {\"ok\":true}\r\n\r\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  try {
    await intercept(
      { url: "/v1beta/models/gemini-3.5-flash-low:streamGenerateContent", headers: { authorization: "Bearer local" } },
      res,
      Buffer.from(JSON.stringify(inputBody)),
      "openai/gpt-5.5-xhigh",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  return { forwardedBody, response: Buffer.concat(chunks).toString("utf8") };
}

// All assertions below are grounded in a live MITM dump capture of Antigravity's
// streamGenerateContent requests (see AI_JOURNAL): the agent loop sends
// `gemini-3.5-flash-low`, tab-autocomplete sends `tab_jump_flash_lite_preview` /
// `tab_flash_lite_preview`.
describe("Antigravity MITM model handling", () => {
  const ag = MITM_TOOLS.antigravity;

  it("flags the out-of-box agent/Default model mandatory", () => {
    expect(ag.defaultModels.find((m) => m.id === "gemini-3.5-flash-low")?.mandatory).toBe(true);
  });

  it("leaves models not proven auto-sent optional", () => {
    for (const id of ["gemini-3-flash-agent", "gemini-3.1-pro-low", "claude-sonnet-4-6", "gpt-oss-120b-medium"]) {
      expect(ag.defaultModels.find((m) => m.id === id)?.mandatory).toBeFalsy();
    }
  });

  // Tab-autocomplete is latency-critical inline completion — it must passthrough natively,
  // never get re-routed onto a chat-model mapping by the broad `flash` pattern.
  it.each(["tab_jump_flash_lite_preview", "tab_flash_lite_preview"])(
    "excludes tab-autocomplete model '%s' from re-routing",
    (id) => {
      expect((MODEL_NO_MAP.antigravity || []).some((re) => re.test(id))).toBe(true);
    }
  );


  it("does not inject model into Antigravity envelope when upstream body has no model field", async () => {
    const input = {
      userAgent: "antigravity",
      request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    };

    const { forwardedBody } = await captureForwardedBody(input);

    expect(forwardedBody).not.toHaveProperty("model");
    expect(forwardedBody.request.contents[0].parts[0].text).toBe("hello");
  });

  it("keeps mapped model replacement for Antigravity envelopes that already carry model", async () => {
    const input = {
      userAgent: "antigravity",
      model: "gemini-3.5-flash-low",
      request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    };

    const { forwardedBody } = await captureForwardedBody(input);

    expect(forwardedBody.model).toBe("openai/gpt-5.5-xhigh");
  });
  it("does not exclude real agent models from re-routing", () => {
    for (const id of ["gemini-3.5-flash-low", "gemini-3-flash-agent", "claude-sonnet-4-6"]) {
      expect((MODEL_NO_MAP.antigravity || []).some((re) => re.test(id))).toBe(false);
    }
  });
});
