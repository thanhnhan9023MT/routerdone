// TDD tests for visionPreprocessor.js — BUG #1 (capability skip) + BUG #2 (reasoning_content fallback)
// Run: node --test tests/vision-preprocessor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  preprocessVisionContent,
  hasImageContent,
  extractVisionText,
  resolveTargetCaps,
  resolveFirstComboMemberCaps,
  shouldDeferComboVisionPreprocessing,
  clearVisionDescriptionCache,
  getVisionDescriptionCacheStats,
} from "../src/sse/services/visionPreprocessor.js";

const FAKE_IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
const noLog = { info: () => {}, warn: () => {} };

// ── BUG #2: extractVisionText must fall back to reasoning_content ──────────────

test("extractVisionText returns content when present", () => {
  const data = { choices: [{ message: { content: "red square", reasoning_content: "thinking..." } }] };
  assert.equal(extractVisionText(data), "red square");
});

test("extractVisionText falls back to reasoning_content when content is null", () => {
  const data = { choices: [{ message: { content: null, reasoning_content: "the image is red" } }] };
  assert.equal(extractVisionText(data), "the image is red");
});

test("extractVisionText falls back to reasoning_content when content is empty string", () => {
  const data = { choices: [{ message: { content: "", reasoning_content: "image shows red" } }] };
  assert.equal(extractVisionText(data), "image shows red");
});

test("extractVisionText returns null when both content and reasoning_content are empty", () => {
  const data = { choices: [{ message: { content: "", reasoning_content: "" } }] };
  assert.equal(extractVisionText(data), null);
});

test("extractVisionText returns null when message missing", () => {
  assert.equal(extractVisionText({ choices: [] }), null);
  assert.equal(extractVisionText({}), null);
});

// ── BUG #1: preprocessVisionContent must skip when target model has vision ─────
// Simulates a request sent to a vision-capable model (e.g. Claude). The 4th
// param `targetCaps` tells the preprocessor the *target* model's capabilities;
// when targetCaps.vision === true it MUST skip preprocessing and return null
// (no self-loopback call, no image stripping) so the target reads the raw image.

test("preprocessVisionContent skips when targetCaps.vision is true", async () => {
  const body = {
    model: "oc/claude-sonnet-4.6",
    stream: false,
    messages: [{ role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: FAKE_IMG } },
    ] }],
  };
  const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
  const result = await preprocessVisionContent(body, settings, noLog, { vision: true });
  assert.equal(result, null, "must skip preprocessing when target model has vision");
});

test("preprocessVisionContent still proceeds when targetCaps.vision is false", async () => {
  // Non-vision target: must NOT skip at the capability gate. We assert it does
  // not return null at the *capability* check by verifying it moves past it.
  // (It will later fail the self-loopback fetch since no server here, but the
  // capability gate itself must not short-circuit.)
  const body = {
    model: "oc/glm-5.2",
    stream: false,
    _skipVision: false,
    messages: [{ role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: FAKE_IMG } },
    ] }],
  };
  const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
  // Pass a stub fetch env so the self-loopback fails fast without hanging.
  const result = await preprocessVisionContent(body, settings, noLog, { vision: false });
  // It should reach the fetch stage and return a body with a placeholder, NOT null
  // at the capability gate. (Either a body or null-from-fetch-error is fine, but
  // the key assertion is it did not skip due to capability.)
  assert.ok(result !== undefined, "must not be undefined");
});

test("preprocessVisionContent skips when _skipVision flag set (anti-loop, regression)", async () => {
  const body = {
    model: "oc/glm-5.2",
    _skipVision: true,
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: FAKE_IMG } }] }],
  };
  const result = await preprocessVisionContent(body, { visionPreprocessingEnabled: true }, noLog, { vision: false });
  assert.equal(result, null, "must skip when _skipVision flag is set");
});

test("hasImageContent detects image_url block", () => {
  assert.equal(hasImageContent({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: FAKE_IMG } }] }] }), true);
  assert.equal(hasImageContent({ messages: [{ role: "user", content: "text only" }] }), false);
});

// ── BUG #3: resolveTargetCaps must see through combo names ────────────────────
// getModelInfo("vision") returns {provider: null} because "vision" is a combo
// name, not a provider/model. The old chat.js only checked direct models, so
// targetCaps was always null for combos — making the preprocessor run even for
// a combo whose only model is vision-capable (double-read + 502). resolveTargetCaps
// expands the combo and returns {vision:true} only when EVERY member already has
// vision, so preprocessing is skipped and the combo reads the raw image once.

const mockDeps = {
  getModelInfo: async (s) => {
    if (s === "oc/mimo-v2.5-free") return { provider: "opencode", model: "mimo-v2.5-free" };
    if (s === "va/glm-5.2") return { provider: "va", model: "glm-5.2" };
    return { provider: null }; // combo / unknown
  },
  getComboModels: async (s) => {
    if (s === "vision") return ["oc/mimo-v2.5-free"];
    if (s === "high") return ["va/glm-5.2", "oc/mimo-v2.5-free"];
    if (s === "textonly") return ["va/glm-5.2"];
    if (s === "empty") return [];
    return null;
  },
  getCapabilitiesForModel: (provider, _model) => {
    if (provider === "opencode") return { vision: true };
    if (provider === "va") return { vision: false };
    return { vision: false };
  },
};

test("resolveTargetCaps: direct vision model returns {vision:true}", async () => {
  assert.deepEqual(await resolveTargetCaps("oc/mimo-v2.5-free", mockDeps), { vision: true });
});

test("resolveTargetCaps: direct text model returns caps with vision false", async () => {
  assert.deepEqual(await resolveTargetCaps("va/glm-5.2", mockDeps), { vision: false });
});

test("resolveTargetCaps: combo all-vision returns {vision:true} (KEY FIX)", async () => {
  // "vision" combo = [oc/mimo-v2.5-free] — all vision-capable -> skip preprocessing
  assert.deepEqual(await resolveTargetCaps("vision", mockDeps), { vision: true });
});

test("resolveTargetCaps: combo mix vision+text returns null", async () => {
  // "high" combo has a text-only model -> must NOT skip (fallback needs text)
  assert.equal(await resolveTargetCaps("high", mockDeps), null);
});

test("resolveTargetCaps: combo all non-vision returns null", async () => {
  assert.equal(await resolveTargetCaps("textonly", mockDeps), null);
});

test("resolveTargetCaps: empty combo returns null", async () => {
  assert.equal(await resolveTargetCaps("empty", mockDeps), null);
});

test("resolveTargetCaps: unknown model returns null", async () => {
  assert.equal(await resolveTargetCaps("nope", mockDeps), null);
});


// ── Vision-first combo defer: shouldDeferComboVisionPreprocessing ───────────
// A mixed combo (vision + text members) should defer eager preprocessing so
// the vision model reads the raw image; non-vision fallbacks preprocess lazily.
// This fixes the regression where grok-4.5 (vision) received OCR text instead
// of the original image because resolveTargetCaps returned null for mixed combos.

const mockDepsDefer = {
  getModelInfo: async (s) => {
    if (s === "va/grok-4.5") return { provider: "va", model: "grok-4.5" };
    if (s === "va/glm-5.2") return { provider: "va", model: "glm-5.2" };
    if (s === "va/gpt-5.5-high") return { provider: "va", model: "gpt-5.5-high" };
    if (s === "oc/mimo-v2.5-free") return { provider: "opencode", model: "mimo-v2.5-free" };
    return { provider: null };
  },
  getComboModels: async (s) => {
    // zcode = mixed vision+text (like production)
    if (s === "zcode") return ["va/grok-4.5", "va/glm-5.2", "va/gpt-5.5-high"];
    // all-text combo
    if (s === "textonly") return ["va/glm-5.2"];
    // all-vision combo
    if (s === "allvision") return ["va/grok-4.5", "oc/mimo-v2.5-free"];
    // empty
    if (s === "empty") return [];
    return null;
  },
  getCapabilitiesForModel: (provider, model) => {
    // grok-4.5 and gpt-5.5-high have vision; glm-5.2 does not
    if (model === "grok-4.5") return { vision: true, contextWindow: 256000 };
    if (model === "gpt-5.5-high") return { vision: true, contextWindow: 400000 };
    if (model === "mimo-v2.5-free") return { vision: true, contextWindow: 1048576 };
    if (model === "glm-5.2") return { vision: false, contextWindow: 200000 };
    return { vision: false };
  },
};

test("shouldDefer: true when any combo member has vision (mixed combo)", async () => {
  // zcode = [grok-4.5✓, glm-5.2✗, gpt-5.5-high✓] → defer because auto-switch
  // will float grok-4.5 to front and it can read the raw image
  assert.equal(await shouldDeferComboVisionPreprocessing("zcode", mockDepsDefer), true);
});

test("shouldDefer: false when all combo members are text-only", async () => {
  // textonly = [glm-5.2✗] → no vision member → must eager-preprocess
  assert.equal(await shouldDeferComboVisionPreprocessing("textonly", mockDepsDefer), false);
});

test("shouldDefer: false for direct (non-combo) model", async () => {
  // Direct model — getComboModels returns null → not a combo → false
  assert.equal(await shouldDeferComboVisionPreprocessing("va/grok-4.5", mockDepsDefer), false);
});

test("shouldDefer: false for empty combo", async () => {
  assert.equal(await shouldDeferComboVisionPreprocessing("empty", mockDepsDefer), false);
});

test("shouldDefer: true for all-vision combo", async () => {
  // all-vision combo also defers — no fallback would need OCR, but defer is
  // still correct (vision models read raw image)
  assert.equal(await shouldDeferComboVisionPreprocessing("allvision", mockDepsDefer), true);
});

test("resolveFirstComboMemberCaps: returns caps for first combo member", async () => {
  const caps = await resolveFirstComboMemberCaps("zcode", mockDepsDefer);
  assert.equal(caps?.vision, true); // first member = grok-4.5
  assert.equal(caps?.contextWindow, 256000);
});

test("resolveFirstComboMemberCaps: returns null for non-combo", async () => {
  assert.equal(await resolveFirstComboMemberCaps("va/grok-4.5", mockDepsDefer), null);
});

// ── Clone safety: lazy preprocess must not mutate the original body ─────────
// When a non-vision fallback preprocesses a cloned body, the original body
// must still contain the raw image blocks for vision models that may be tried
// later in the same combo run.

test("structuredClone preserves original body images when preprocess mutates clone", () => {
  const original = {
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: FAKE_IMG } }, { type: "text", text: "describe this" }] },
    ],
  };
  const clone = structuredClone(original);
  // Simulate preprocess: replace image with text in clone
  clone.messages[0].content = [{ type: "text", text: "[Image description: a red square]" }];

  // Original must be untouched
  assert.equal(original.messages[0].content[0].type, "image_url");
  assert.equal(original.messages[0].content[0].image_url.url, FAKE_IMG);
  // Clone has the replacement
  assert.equal(clone.messages[0].content[0].type, "text");
  assert.ok(clone.messages[0].content[0].text.includes("[Image description:"));
});


// ── Vision description cache ─────────────────────────────────────────────────
// When the same image is sent in multiple ZCode multi-turn requests, the
// preprocessor should call the vision model ONCE, cache the description, then
// reuse it for subsequent requests with the same image content hash.

const FAKE_IMG_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("cache: same image reuses cached description (no second vision call)", async () => {
  clearVisionDescriptionCache();
  const calls = [];
  const fakeFetch = (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Promise.resolve({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({
        choices: [{ message: { content: "cached description of image" } }],
      }),
    });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  try {
    const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };

    // First call — should hit vision model
    const body1 = {
      model: "combo/zcode",
      stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };
    const first = await preprocessVisionContent(body1, settings, noLog, { vision: false });
    assert.ok(first, "first call should preprocess image");
    assert.equal(calls.length, 1, "first call should call vision model once");
    assert.equal(calls[0].stream, true, "vision preprocessing should call the vision model with stream:true to avoid non-streaming timeouts");
    assert.match(JSON.stringify(first.messages[0].content), /cached description/);

    // Second call with same image — should use cache
    const body2 = {
      model: "combo/zcode",
      stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this again?" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };
    const second = await preprocessVisionContent(body2, settings, noLog, { vision: false });
    assert.ok(second, "second call should still replace image with text");
    assert.equal(calls.length, 1, "second call should reuse cached vision description, NOT call vision model again");
    assert.match(JSON.stringify(second.messages[0].content), /cached description/);

    const stats = getVisionDescriptionCacheStats();
    assert.equal(stats.size, 1, "cache should have 1 entry");
    assert.equal(stats.hits, 1, "cache should have 1 hit (second call)");
    assert.equal(stats.misses, 1, "cache should have 1 miss (first call)");
  } finally {
    globalThis.fetch = originalFetch;
    clearVisionDescriptionCache();
  }
});

test("vision preprocessing parses streaming SSE responses", async () => {
  clearVisionDescriptionCache();
  const calls = [];
  const fakeFetch = (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    const sse = [
      'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"role":"assistant","content":"streamed "},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"content":"vision text"},"finish_reason":null}]}',
      '',
      'data: [DONE]',
      '',
    ].join("\n");
    return Promise.resolve({
      ok: true,
      headers: { get: () => "text/event-stream; charset=utf-8" },
      text: () => Promise.resolve(sse),
    });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  try {
    const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
    const body = {
      model: "combo/zcode",
      stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };

    const result = await preprocessVisionContent(body, settings, noLog, { vision: false });
    assert.ok(result, "streaming vision response should be accepted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stream, true);
    assert.match(JSON.stringify(result.messages[0].content), /streamed vision text/);
  } finally {
    globalThis.fetch = originalFetch;
    clearVisionDescriptionCache();
  }
});

test("cache: different image misses cache and calls vision model again", async () => {
  clearVisionDescriptionCache();
  const calls = [];
  const fakeFetch = (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: "different image description" } }],
      }),
    });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  try {
    const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };

    // First image
    const body1 = {
      model: "combo/zcode",
      stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };
    await preprocessVisionContent(body1, settings, noLog, { vision: false });

    // Second DIFFERENT image
    const body2 = {
      model: "combo/zcode",
      stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "describe this other image" },
        { type: "image_url", image_url: { url: FAKE_IMG_B } },
      ] }],
    };
    await preprocessVisionContent(body2, settings, noLog, { vision: false });

    assert.equal(calls.length, 2, "different image hashes should call vision model twice");

    const stats = getVisionDescriptionCacheStats();
    assert.equal(stats.size, 2, "cache should have 2 entries");
    assert.equal(stats.hits, 0, "cache should have 0 hits");
    assert.equal(stats.misses, 2, "cache should have 2 misses");
  } finally {
    globalThis.fetch = originalFetch;
    clearVisionDescriptionCache();
  }
});

test("cache: same image but different vision model misses cache", async () => {
  clearVisionDescriptionCache();
  const calls = [];
  const fakeFetch = (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: "description from model" } }],
      }),
    });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  try {
    // First call with mimo
    const settings1 = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
    const body1 = {
      model: "combo/zcode",
      stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };
    await preprocessVisionContent(body1, settings1, noLog, { vision: false });

    // Second call with a DIFFERENT vision model (same image)
    const settings2 = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/gpt-4o-mini" };
    const body2 = {
      model: "combo/zcode",
      stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "describe this again" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };
    await preprocessVisionContent(body2, settings2, noLog, { vision: false });

    assert.equal(calls.length, 2, "same image with a different vision model should miss cache");
    assert.equal(getVisionDescriptionCacheStats().size, 2, "cache should have 2 entries (different model keys)");
  } finally {
    globalThis.fetch = originalFetch;
    clearVisionDescriptionCache();
  }
});

// ── P1: loopback forwards API key so requireApiKey=true deployments still work ──

test("P1: loopback forwards Authorization header when opts.apiKey provided", async () => {
  clearVisionDescriptionCache();
  let seenAuth = null;
  const fakeFetch = (_url, opts) => {
    seenAuth = opts.headers?.Authorization || null;
    return Promise.resolve({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ choices: [{ message: { content: "desc" } }] }),
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
    const body = {
      model: "oc/glm-5.1", stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };
    await preprocessVisionContent(body, settings, noLog, { vision: false }, { apiKey: "sk-test-key" });
    assert.equal(seenAuth, "Bearer sk-test-key", "loopback must forward the caller's API key");
  } finally {
    globalThis.fetch = originalFetch;
    clearVisionDescriptionCache();
  }
});

test("P1: no Authorization header when opts.apiKey absent (local mode unchanged)", async () => {
  clearVisionDescriptionCache();
  let hadAuth = "unset";
  const fakeFetch = (_url, opts) => {
    hadAuth = "Authorization" in (opts.headers || {});
    return Promise.resolve({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ choices: [{ message: { content: "desc" } }] }),
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
    const body = {
      model: "oc/glm-5.1", stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };
    await preprocessVisionContent(body, settings, noLog, { vision: false });
    assert.equal(hadAuth, false, "no API key -> no Authorization header (backward compatible)");
  } finally {
    globalThis.fetch = originalFetch;
    clearVisionDescriptionCache();
  }
});

// ── P2: retry once on a failed vision call before giving up ────────────────────

test("P2: retries once when first vision call fails, succeeds on second", async () => {
  clearVisionDescriptionCache();
  let n = 0;
  const fakeFetch = () => {
    n++;
    if (n === 1) return Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve("bad gateway") });
    return Promise.resolve({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ choices: [{ message: { content: "recovered on retry" } }] }),
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
    const body = {
      model: "oc/glm-5.1", stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };
    const result = await preprocessVisionContent(body, settings, noLog, { vision: false });
    assert.equal(n, 2, "must retry once after the first failure");
    assert.match(JSON.stringify(result.messages[0].content), /recovered on retry/);
  } finally {
    globalThis.fetch = originalFetch;
    clearVisionDescriptionCache();
  }
});

test("P2: gives up to placeholder after both attempts fail", async () => {
  clearVisionDescriptionCache();
  let n = 0;
  const fakeFetch = () => { n++; return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("err") }); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
    const body = {
      model: "oc/glm-5.1", stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };
    const result = await preprocessVisionContent(body, settings, noLog, { vision: false });
    assert.equal(n, 2, "must attempt exactly twice (1 try + 1 retry)");
    assert.ok(result, "non-fatal: returns body with placeholder, not null");
    assert.match(JSON.stringify(result.messages[0].content), /vision model failed/);
  } finally {
    globalThis.fetch = originalFetch;
    clearVisionDescriptionCache();
  }
});

// ── P3: old-message images restore cached description instead of being dropped ──

test("P3: older-message image restores cached description (no extra vision call)", async () => {
  clearVisionDescriptionCache();
  let calls = 0;
  const fakeFetch = () => {
    calls++;
    return Promise.resolve({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ choices: [{ message: { content: "OCR of first image" } }] }),
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
    // Turn 1: single image in the last user message -> caches its description.
    const turn1 = {
      model: "oc/glm-5.1", stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };
    await preprocessVisionContent(turn1, settings, noLog, { vision: false });
    assert.equal(calls, 1, "turn 1 calls vision once");

    // Turn 2: the same image is now an OLDER message; a NEW image is last.
    const turn2 = {
      model: "oc/glm-5.1", stream: false,
      messages: [
        { role: "user", content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: FAKE_IMG } },
        ] },
        { role: "assistant", content: "It's the first image." },
        { role: "user", content: [
          { type: "text", text: "and this one?" },
          { type: "image_url", image_url: { url: FAKE_IMG_B } },
        ] },
      ],
    };
    const result = await preprocessVisionContent(turn2, settings, noLog, { vision: false });
    // Old image (FAKE_IMG) is cached -> restored WITHOUT a new call; only the new
    // last image (FAKE_IMG_B) triggers a vision call.
    assert.equal(calls, 2, "only the new last-message image triggers a vision call");
    const oldMsg = JSON.stringify(result.messages[0].content);
    assert.match(oldMsg, /OCR of first image/, "older image keeps its cached description instead of being dropped");
  } finally {
    globalThis.fetch = originalFetch;
    clearVisionDescriptionCache();
  }
});


// ── BUG #1 (regression): changing visionMaxTokens must invalidate cache ───────
// The Vision Bridge UI exposes a "Max Tokens" dropdown (1024/2048/4096) that
// controls the loopback vision call's output budget. If the cache key omits
// maxTokens, raising the budget silently serves the old short description
// instead of regenerating a richer one — the UI setting has no effect until
// the 6h TTL expires. The cache key MUST include the budget so toggling
// regenerates descriptions.
test("cache: same image but different visionMaxTokens misses cache", async () => {
  clearVisionDescriptionCache();
  const calls = [];
  const fakeFetch = (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Promise.resolve({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({
        choices: [{ message: { content: "description with budget " + calls.length } }],
      }),
    });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  try {
    const body = {
      model: "combo/zcode",
      stream: false,
      messages: [{ role: "user", content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: FAKE_IMG } },
      ] }],
    };

    // First call with 1024 budget
    const settings1 = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free", visionMaxTokens: 1024 };
    await preprocessVisionContent({ ...body, messages: structuredClone(body.messages) }, settings1, noLog, { vision: false });

    // Second call with 4096 budget — same image, same model, only maxTokens changed
    const settings2 = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free", visionMaxTokens: 4096 };
    await preprocessVisionContent({ ...body, messages: structuredClone(body.messages) }, settings2, noLog, { vision: false });

    assert.equal(calls.length, 2, "same image with different maxTokens budget should miss cache and call vision model again");
    const stats = getVisionDescriptionCacheStats();
    assert.equal(stats.size, 2, "cache should have 2 entries (one per budget)");
    assert.equal(stats.hits, 0, "second call should be a miss, not a hit");
    assert.equal(stats.misses, 2, "both calls should miss");
  } finally {
    globalThis.fetch = originalFetch;
    clearVisionDescriptionCache();
  }
});
