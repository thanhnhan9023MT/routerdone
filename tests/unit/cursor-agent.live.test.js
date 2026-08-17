/**
 * LIVE integration test — actually spawns cursor-agent with a real key.
 * Gated on CURSOR_LIVE_KEY so it never runs in normal CI.
 * Run: CURSOR_LIVE_KEY=crsr_... vitest run unit/cursor-agent.live.test.js
 */
import { describe, it, expect } from "vitest";
import { CursorAgentExecutor } from "../../open-sse/executors/cursor-agent.js";

const KEY = process.env.CURSOR_LIVE_KEY;
const MODEL = process.env.CURSOR_LIVE_MODEL || "claude-4.5-sonnet";
const maybe = KEY ? describe : describe.skip;

async function collectSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!frame.startsWith("data:")) continue;
      const payload = frame.slice(5).trim();
      if (payload === "[DONE]") { events.push({ done: true }); continue; }
      events.push(JSON.parse(payload));
    }
  }
  return events;
}

maybe("cursor-agent LIVE", () => {
  it("streams a valid OpenAI SSE completion", async () => {
    const exec = new CursorAgentExecutor();
    const { response } = await exec.execute({
      model: MODEL,
      body: { messages: [{ role: "user", content: "Reply with exactly the word: PONG" }] },
      credentials: { apiKey: KEY },
      log: () => {},
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSse(response);
    const chunks = events.filter((e) => e.object === "chat.completion.chunk");

    // role opener
    expect(chunks[0]?.choices?.[0]?.delta?.role).toBe("assistant");
    // at least one content delta
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
    expect(text.length).toBeGreaterThan(0);
    expect(text.toUpperCase()).toContain("PONG");
    // terminal chunk + [DONE]
    expect(chunks.at(-1)?.choices?.[0]?.finish_reason).toBe("stop");
    expect(events.at(-1)?.done).toBe(true);
  }, 120_000);

  it("returns 400 for an unavailable model", async () => {
    const exec = new CursorAgentExecutor();
    const { response } = await exec.execute({
      model: "bogus-model-xyz",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: KEY },
      log: () => {},
    });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(String(json.error.message).toLowerCase()).toContain("cannot use this model");
  }, 120_000);

  it("emulates function calling: emits OpenAI tool_calls from tools[]", async () => {
    const exec = new CursorAgentExecutor();
    const { response } = await exec.execute({
      model: MODEL,
      body: {
        messages: [{ role: "user", content: "What's the weather in Hanoi right now? Use celsius." }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get the current weather for a city",
              parameters: { type: "object", properties: { city: { type: "string" }, unit: { type: "string" } }, required: ["city"] },
            },
          },
        ],
      },
      credentials: { apiKey: KEY },
      log: () => {},
    });
    expect(response.status).toBe(200);

    const events = await collectSse(response);
    const chunks = events.filter((e) => e.object === "chat.completion.chunk");
    // find the tool_calls delta + the tool_calls finish
    const toolDelta = chunks.map((c) => c.choices?.[0]?.delta?.tool_calls).find(Boolean);
    const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).pop();

    expect(finish).toBe("tool_calls");
    expect(Array.isArray(toolDelta)).toBe(true);
    expect(toolDelta[0].type).toBe("function");
    expect(toolDelta[0].function.name).toBe("get_weather");
    const args = JSON.parse(toolDelta[0].function.arguments);
    expect(String(args.city).toLowerCase()).toContain("hanoi");
  }, 120_000);

  it("returns 401 for an invalid key", async () => {
    const exec = new CursorAgentExecutor();
    const { response } = await exec.execute({
      model: "auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { apiKey: "crsr_0000000000000000000000000000000000000000000000000000000000000000" },
      log: () => {},
    });
    expect(response.status).toBe(401);
  }, 120_000);
});
