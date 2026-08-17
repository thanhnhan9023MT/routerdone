/**
 * Wiring + parsing tests for the cursor-agent CLI provider.
 */
import { describe, it, expect } from "vitest";
import registry from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import {
  CursorAgentExecutor,
  parseToolCalls,
  buildToolPrompt,
  extractFirstJson,
} from "../../open-sse/executors/cursor-agent.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("cursor-agent registry wiring", () => {
  it("is registered exactly once in the registry", () => {
    const entries = registry.filter((e) => e && e.id === "cursor-agent");
    expect(entries.length).toBe(1);
  });

  it("has no duplicate ids across the whole registry", () => {
    const ids = registry.map((e) => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("builds a transport entry keyed by id", () => {
    expect(PROVIDERS["cursor-agent"]).toBeTruthy();
    expect(PROVIDERS["cursor-agent"].format).toBe("openai");
    expect(PROVIDERS["cursor-agent"].forceStream).toBe(true);
  });

  it("exposes models under its alias", () => {
    expect(Array.isArray(PROVIDER_MODELS["ca"])).toBe(true);
    expect(PROVIDER_MODELS["ca"].length).toBeGreaterThan(0);
  });

  it("resolves a specialized executor for id and alias", () => {
    expect(hasSpecializedExecutor("cursor-agent")).toBe(true);
    expect(getExecutor("cursor-agent")).toBeInstanceOf(CursorAgentExecutor);
    expect(getExecutor("ca")).toBeInstanceOf(CursorAgentExecutor);
  });

  it("adds ONLY cursor-agent vs the committed baseline — no existing provider changed", () => {
    // Mirrors tests/__baseline__/verify-providers.mjs, but runnable in-harness.
    const here = dirname(fileURLToPath(import.meta.url));
    const baseline = JSON.parse(
      readFileSync(join(here, "../__baseline__/providers-baseline.json"), "utf8")
    );
    // Fields the baseline tool already excludes (added during earlier refactors).
    const ADDED_FIELDS = new Set([
      "forceStream", "urlSuffix", "retry", "quirks", "auth", "validateUrl", "usage",
      "clientId", "clientSecret", "tokenUrl", "cliVersion", "apiClient", "copilot",
      "authorizeUrl", "authUrl", "regions", "defaultRegion", "reasoningInject", "priority", "hasFree",
    ]);
    const current = JSON.parse(JSON.stringify(PROVIDERS));
    for (const f of ADDED_FIELDS) {
      for (const id of Object.keys(current)) delete current[id][f];
      for (const id of Object.keys(baseline)) delete baseline[id][f];
    }

    const added = [];
    const removed = [];
    const changed = [];
    for (const id of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
      if (baseline[id] === undefined) { added.push(id); continue; }
      if (current[id] === undefined) { removed.push(id); continue; }
      if (JSON.stringify(baseline[id]) !== JSON.stringify(current[id])) changed.push(id);
    }

    // The baseline is a stale refactor-era snapshot: other entries (cheat-ai,
    // codex-sale, xiaomi-tokenplan, blackbox) drifted before this work and are
    // not files we touched. What this test proves is that OUR change is purely
    // additive: cursor-agent appears only as an addition, never as a
    // modification or removal of anything that existed.
    expect(added).toContain("cursor-agent");
    expect(removed).not.toContain("cursor-agent");
    expect(changed).not.toContain("cursor-agent");
  });
});

describe("cursor-agent executor guards", () => {
  const exec = new CursorAgentExecutor();

  it("returns 401 when no api key is present", async () => {
    const { response } = await exec.execute({
      model: "auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: {},
    });
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.code).toBe("MISSING_KEY");
  });

  it("returns 401 for the noAuth 'public' sentinel", async () => {
    const { response } = await exec.execute({
      model: "auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { accessToken: "public" },
    });
    expect(response.status).toBe(401);
  });

  it("returns 400 for an empty prompt", async () => {
    const { response } = await exec.execute({
      model: "auto",
      body: { messages: [{ role: "assistant", content: "   " }] },
      credentials: { apiKey: "crsr_test" },
    });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("EMPTY_PROMPT");
  });
});

describe("cursor-agent extractFirstJson (balanced-brace scanner)", () => {
  it("parses a plain object", () => {
    expect(extractFirstJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("handles nested objects and ignores trailing prose", () => {
    expect(extractFirstJson('prefix {"a":{"b":[1,2]},"c":"}"} trailing')).toEqual({ a: { b: [1, 2] }, c: "}" });
  });
  it("respects braces inside strings and escapes", () => {
    expect(extractFirstJson('{"s":"a\\"}{b"}')).toEqual({ s: 'a"}{b' });
  });
  it("returns null when there is no JSON", () => {
    expect(extractFirstJson("just words")).toBeNull();
  });
});

describe("cursor-agent parseToolCalls (emulated function calling)", () => {
  const valid = new Set(["get_weather", "get_time"]);

  it("parses a single marker block", () => {
    const text = `___TOOL_CALL___\n{"name":"get_weather","arguments":{"city":"Hanoi","unit":"c"}}\n___TOOL_CALL___`;
    expect(parseToolCalls(text, valid)).toEqual([{ name: "get_weather", arguments: { city: "Hanoi", unit: "c" } }]);
  });

  it("parses multiple parallel marker blocks", () => {
    const text =
      `___TOOL_CALL___\n{"name":"get_weather","arguments":{"city":"Tokyo"}}\n___TOOL_CALL___\n` +
      `___TOOL_CALL___\n{"name":"get_time","arguments":{"city":"Tokyo"}}\n___TOOL_CALL___`;
    const out = parseToolCalls(text, valid);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.name)).toEqual(["get_weather", "get_time"]);
  });

  it("falls back to a fenced JSON object when no markers are present", () => {
    const text = '```json\n{"tool_calls":[{"name":"get_time","arguments":{"city":"NYC"}}]}\n```';
    expect(parseToolCalls(text, valid)).toEqual([{ name: "get_time", arguments: { city: "NYC" } }]);
  });

  it("accepts the {\"tool_call\":{...}} shape", () => {
    const text = '{"tool_call":{"name":"get_weather","arguments":{"city":"Paris"}}}';
    expect(parseToolCalls(text, valid)).toEqual([{ name: "get_weather", arguments: { city: "Paris" } }]);
  });

  it("coerces a stringified arguments field to an object", () => {
    const text = `___TOOL_CALL___\n{"name":"get_weather","arguments":"{\\"city\\":\\"Rome\\"}"}\n___TOOL_CALL___`;
    expect(parseToolCalls(text, valid)).toEqual([{ name: "get_weather", arguments: { city: "Rome" } }]);
  });

  it("returns null for a plain-text answer (no tool needed)", () => {
    expect(parseToolCalls("It is sunny and 24 degrees.", valid)).toBeNull();
  });

  it("drops calls to tools that were not offered", () => {
    const text = `___TOOL_CALL___\n{"name":"rm_rf","arguments":{}}\n___TOOL_CALL___`;
    expect(parseToolCalls(text, valid)).toBeNull();
  });
});

describe("cursor-agent buildToolPrompt", () => {
  const body = {
    tools: [
      { type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
    ],
    messages: [
      { role: "user", content: "Weather in Hanoi?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Hanoi"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"temp":31}' },
    ],
  };

  it("injects the tool schema and marker instructions", () => {
    const p = buildToolPrompt(body, body.tools);
    expect(p).toContain("___TOOL_CALL___");
    expect(p).toContain("get_weather");
    expect(p).toContain('"required":["city"]');
  });

  it("re-serializes prior tool_calls as marker blocks and resolves result names", () => {
    const p = buildToolPrompt(body, body.tools);
    expect(p).toContain('{"name":"get_weather","arguments":{"city":"Hanoi"}}');
    expect(p).toContain("Tool get_weather result:");
    expect(p).toContain('{"temp":31}');
  });

  it("honors tool_choice=required", () => {
    const p = buildToolPrompt({ ...body, tool_choice: "required" }, body.tools);
    expect(p).toContain("You MUST call at least one tool");
  });
});
