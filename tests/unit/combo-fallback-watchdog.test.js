import { describe, it, expect, beforeEach, vi } from "vitest";

import { handleComboChat, getRotatedModels, resetComboRotation, resetComboCooldowns, getComboCooldownState } from "../../open-sse/services/combo.js";
import { parseResetAfterText, parseRetryAfterHeader } from "../../open-sse/utils/error.js";
import { guardInitialStream, handleStreamingResponse, isProductiveStreamChunk, isRetryableEmptyStreamError } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { resolveRoutePolicy } from "../../open-sse/services/routePolicy.js";
import { isBusyConcurrencyError, shouldLockConnectionForError, resolveConnectionCooldownMs } from "../../open-sse/services/accountFallback.js";

describe("adaptive combo fallback", () => {
  beforeEach(() => { resetComboRotation(); resetComboCooldowns(); });

  const log = { info: () => {}, warn: () => {}, debug: () => {} };

  it("falls back immediately on combo 429 without retrying the same model", async () => {
    const tried = [];
    const res = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 3,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model === "p/a") return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(res.ok).toBe(true);
    expect(tried).toEqual(["p/a", "p/b"]);
  });

  it("retries transient 503 according to config, then falls back", async () => {
    const tried = [];
    const res = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 1,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model === "p/a") return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(res.ok).toBe(true);
    expect(tried).toEqual(["p/a", "p/a", "p/b"]);
  });

  it("round-robin only chooses start; failed starter still falls through remaining models", async () => {
    expect(getRotatedModels(["p/a", "p/b", "p/c"], "rr", "round-robin")[0]).toBe("p/a");
    const tried = [];
    const res = await handleComboChat({
      body: { model: "rr", messages: [] },
      models: ["p/a", "p/b", "p/c"],
      comboName: "rr",
      comboStrategy: "round-robin",
      comboRetryAttempts: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model !== "p/c") return new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(res.ok).toBe(true);
    expect(tried).toEqual(["p/b", "p/c"]);
  });

  it("still attempts a cooling model instead of hard-skipping it (live model always reachable)", async () => {
    // 1st request: model trips a preflight-timeout, which arms its in-memory
    // combo cooldown window.
    let phase = "warm";
    const run = () => handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/only"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async () => {
        if (phase === "warm") {
          return new Response(
            JSON.stringify({ error: { message: "Upstream first productive timeout (9s)" } }),
            { status: 502 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const first = await run();
    expect(first.ok).toBe(false);

    // 2nd request: the same model is now in cooldown but is alive again. It must
    // still be tried (soft de-prioritization), not skipped into an all-failed 503.
    phase = "live";
    const tried = [];
    const second = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/only"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(tried).toEqual(["p/only"]);
    expect(second.ok).toBe(true);
  });

  it("sinks a cooling model to the end but still reaches it when others fail", async () => {
    // Arm cooldown on p/a via a preflight timeout.
    await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async () => new Response(
        JSON.stringify({ error: { message: "upstream first productive timeout" } }),
        { status: 502 },
      ),
    });

    // p/a is cooling and p/b fails: p/a must be moved last but STILL tried, and
    // since it is alive again the combo succeeds.
    const tried = [];
    const res = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model === "p/b") return new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(tried).toEqual(["p/b", "p/a"]);
    expect(res.ok).toBe(true);
  });

  it("arms soft cooldown from fallback errors without relying on auth DB locks", async () => {
    const firstTried = [];
    const first = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        firstTried.push(model);
        if (model === "p/a") return new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(first.ok).toBe(true);
    expect(firstTried).toEqual(["p/a", "p/b"]);
    expect(getComboCooldownState("p/a").failureCount).toBe(1);

    const secondTried = [];
    const second = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        secondTried.push(model);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(second.ok).toBe(true);
    expect(secondTried).toEqual(["p/b"]);
  });

  it("escalates the cooldown exponentially on consecutive failures, capped", async () => {
    const preflightFail = async () => new Response(
      JSON.stringify({ error: { message: "upstream first productive timeout" } }),
      { status: 502 },
    );
    const armOnce = () => handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: preflightFail,
    });

    await armOnce();
    const s1 = getComboCooldownState("p/a");
    expect(s1.failureCount).toBe(1);
    // base window ~30s (allow slack for elapsed time during the call)
    expect(s1.remainingMs).toBeGreaterThan(25_000);
    expect(s1.remainingMs).toBeLessThanOrEqual(30_000);

    await armOnce();
    const s2 = getComboCooldownState("p/a");
    expect(s2.failureCount).toBe(2);
    // doubled: ~60s
    expect(s2.remainingMs).toBeGreaterThan(50_000);
    expect(s2.remainingMs).toBeLessThanOrEqual(60_000);

    await armOnce();
    const s3 = getComboCooldownState("p/a");
    expect(s3.failureCount).toBe(3);
    // doubled again: ~120s
    expect(s3.remainingMs).toBeGreaterThan(100_000);
    expect(s3.remainingMs).toBeLessThanOrEqual(120_000);

    // Many more failures must saturate at the 30-minute cap, not grow unbounded.
    for (let i = 0; i < 6; i++) await armOnce();
    const sCap = getComboCooldownState("p/a");
    expect(sCap.failureCount).toBe(9);
    expect(sCap.remainingMs).toBeGreaterThan(29 * 60_000);
    expect(sCap.remainingMs).toBeLessThanOrEqual(30 * 60_000);
  });

  it("resets the cooldown counter to base after one successful call", async () => {
    const preflightFail = async () => new Response(
      JSON.stringify({ error: { message: "upstream first productive timeout" } }),
      { status: 502 },
    );
    const arm = (fn) => handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: fn,
    });

    await arm(preflightFail);
    await arm(preflightFail);
    expect(getComboCooldownState("p/a").failureCount).toBe(2);

    // A 2xx clears both the counter and the active cooldown window.
    const ok = await arm(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(ok.ok).toBe(true);
    expect(getComboCooldownState("p/a")).toEqual({ remainingMs: 0, failureCount: 0 });

    // Next failure starts back at the base window, not the escalated one.
    await arm(preflightFail);
    const after = getComboCooldownState("p/a");
    expect(after.failureCount).toBe(1);
    expect(after.remainingMs).toBeGreaterThan(25_000);
    expect(after.remainingMs).toBeLessThanOrEqual(30_000);
  });
  it("resets stale combo backoff after the cooldown window expires", async () => {
    vi.useFakeTimers();
    try {
      const preflightFail = async () => new Response(
        JSON.stringify({ error: { message: "upstream first productive timeout" } }),
        { status: 502 },
      );
      const arm = () => handleComboChat({
        body: { model: "combo", messages: [] },
        models: ["p/a"],
        comboName: "combo",
        comboRetryAttempts: 0,
        comboRetryDelayMs: 0,
        log,
        handleSingleModel: preflightFail,
      });

      await arm();
      vi.advanceTimersByTime(29_000);
      await arm();
      expect(getComboCooldownState("p/a").failureCount).toBe(2);

      vi.advanceTimersByTime(61_000);
      await arm();
      const after = getComboCooldownState("p/a");
      expect(after.failureCount).toBe(1);
      expect(after.remainingMs).toBeGreaterThan(25_000);
      expect(after.remainingMs).toBeLessThanOrEqual(30_000);
    } finally {
      vi.useRealTimers();
    }
  });
  it("deprioritizes auth-locked combo models and resets after success", async () => {
    const authLocked = () => new Response(
      JSON.stringify({ error: { message: "all accounts locked", comboCooldownReason: "auth_model_locked" } }),
      { status: 503 },
    );

    const firstTried = [];
    const first = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log: { info: () => {}, warn: () => {}, debug: () => {} },
      handleSingleModel: async (_body, model) => {
        firstTried.push(model);
        if (model === "p/a") return authLocked();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(first.ok).toBe(true);
    expect(firstTried).toEqual(["p/a", "p/b"]);
    const afterAuthLock = getComboCooldownState("p/a");
    expect(afterAuthLock.failureCount).toBe(1);
    expect(afterAuthLock.remainingMs).toBeGreaterThan(25_000);
    expect(afterAuthLock.remainingMs).toBeLessThanOrEqual(30_000);

    const secondTried = [];
    const second = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        secondTried.push(model);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(second.ok).toBe(true);
    expect(secondTried).toEqual(["p/b"]);
    expect(getComboCooldownState("p/a").failureCount).toBe(1);

    const resetTried = [];
    const reset = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        resetTried.push(model);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(reset.ok).toBe(true);
    expect(resetTried).toEqual(["p/a"]);
    expect(getComboCooldownState("p/a")).toEqual({ remainingMs: 0, failureCount: 0 });
  });
  it("emits combo summary counters", async () => {
    const infos = [];
    const summaryLog = { info: (_tag, msg) => infos.push(msg), warn: () => {}, debug: () => {} };
    const res = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 0,
      log: summaryLog,
      handleSingleModel: async (_body, model) => {
        if (model === "p/a") return new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(res.ok).toBe(true);
    expect(infos.some(msg => msg.includes("summary | combo=combo | success=p/b | tried=2") && msg.includes("failed=1"))).toBe(true);
  });
});

describe("productive stream watchdog", () => {
  const log = { warn: () => {} };

  function sseResponse(lines, keepOpen = false) {
    return new Response(new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
        if (!keepOpen) controller.close();
      }
    }), { headers: { "Content-Type": "text/event-stream" } });
  }

  it("rejects DONE without content before client response starts", async () => {
    const res = await guardInitialStream(sseResponse(["data: [DONE]\n\n"]), {
      targetFormat: null, log, provider: "p", model: "m",
      policy: { firstByteTimeoutMs: 5, firstProductiveTimeoutMs: 20, totalBudgetMs: 50 },
    });
    expect(res.error).toMatch(/Empty upstream stream/);
    expect(isRetryableEmptyStreamError(res.error)).toBe(true);
  });

  it("only retries empty upstream preflight failures", () => {
    expect(isRetryableEmptyStreamError("Empty upstream stream (terminal before productive)")).toBe(true);
    expect(isRetryableEmptyStreamError("Empty upstream stream before content")).toBe(true);
    expect(isRetryableEmptyStreamError("Upstream stream error: rate limited")).toBe(false);
  });

  it("retries an empty upstream stream once before returning to the client", async () => {
    let retries = 0;
    const streamController = {
      signal: new AbortController().signal,
      startTime: Date.now(),
      isConnected: () => true,
      handleComplete: () => {},
      handleError: error => { throw error; },
      handleDisconnect: () => {},
      abort: () => {},
    };

    const result = await handleStreamingResponse({
      providerResponse: sseResponse(["data: [DONE]\n\n"]),
      provider: "p",
      model: "m",
      sourceFormat: null,
      targetFormat: null,
      userAgent: "test",
      body: {},
      stream: true,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "test-conn",
      apiKey: "test-key",
      clientRawRequest: {},
      reqLogger: { logTargetResponse: () => {} },
      toolNameMap: {},
      streamController,
      onStreamComplete: () => {},
      log,
      streamTimeoutPolicy: { idleAfterProductiveMs: 1000 },
      retryFn: async () => {
        retries += 1;
        return { response: sseResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", "data: [DONE]\n\n"]) };
      },
      emptyStreamRetryDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(retries).toBe(1);
    await result.response.text();
  });
  it("does not treat metadata-only chunks as productive", async () => {
    const res = await guardInitialStream(sseResponse(["data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n"], true), {
      targetFormat: null, log, provider: "p", model: "m",
      policy: { firstByteTimeoutMs: 5, firstProductiveTimeoutMs: 20, totalBudgetMs: 60 },
    });
    expect(res.error).toMatch(/productive timeout/);
  }, 10000);

  it("counts content, thinking, and tool calls as productive", () => {
    expect(isProductiveStreamChunk({ choices: [{ delta: { content: "hi" } }] })).toBe(true);
    expect(isProductiveStreamChunk({ choices: [{ delta: { reasoning_content: "thinking" } }] })).toBe(true);
    expect(isProductiveStreamChunk({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] })).toBe(true);
    expect(isProductiveStreamChunk({ choices: [{ delta: { role: "assistant" } }] })).toBe(false);
    expect(isProductiveStreamChunk({ usage: { prompt_tokens: 1, completion_tokens: 0 } })).toBe(false);
  });

  it("honors route policy for initial stream preflight", async () => {
    let pullCount = 0;
    const res = await guardInitialStream(new Response(new ReadableStream({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode("data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n"));
        }
      }
    }), { headers: { "Content-Type": "text/event-stream" } }), {
      targetFormat: null, log, provider: "p", model: "m",
      policy: { firstByteTimeoutMs: 5, firstProductiveTimeoutMs: 20, totalBudgetMs: 60 },
    });
    expect(res.error).toMatch(/productive timeout \(1s\)/);
  }, 10000);
  it("direct default timeout is longer than combo default timeout", () => {
    expect(resolveRoutePolicy("direct").stream.firstProductiveTimeoutMs).toBeGreaterThan(resolveRoutePolicy("combo").stream.firstProductiveTimeoutMs);
  });

  it("extends combo preflight for high-effort reasoning models", async () => {
    const seen = [];
    await handleComboChat({
      body: { model: "combo", messages: [], reasoning_effort: "xhigh" },
      models: ["sk/claude-opus-4.8-thinking"],
      comboName: "combo",
      comboRetryAttempts: 0,
      log: { info: () => {}, warn: () => {}, debug: () => {} },
      handleSingleModel: async (_body, _model, ctx) => {
        seen.push(ctx.streamTimeoutPolicy.firstProductiveTimeoutMs);
        return new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 });
      },
    });
    expect(seen[0]).toBeGreaterThan(resolveRoutePolicy("combo").stream.firstProductiveTimeoutMs);
    expect(seen[0]).toBe(45_000);
  });
});

describe("retry-after parsing", () => {
  it("parses Retry-After header and reset-after text", () => {
    const h = new Headers({ "Retry-After": "7" });
    expect(parseRetryAfterHeader(h)).toBeGreaterThan(Date.now() + 6000);
    const reset = parseResetAfterText("quota exceeded, reset after 2m 7s");
    expect(reset).toBeGreaterThan(Date.now() + 120000);
    expect(reset).toBeLessThan(Date.now() + 130000);
  });
});

describe("busy and connection cooldown classification", () => {
  it("classifies provider busy/concurrency text for short account cooldown", () => {
    for (const msg of [
      "Hệ thống đang bận, vui lòng thử lại",
      "system busy",
      "try again later",
      "please wait",
      "POOL LIMIT",
      "maximum concurrent requests",
      "too many in-flight requests",
    ]) {
      expect(isBusyConcurrencyError(msg)).toBe(true);
      expect(shouldLockConnectionForError({ status: 429, errorText: msg, recentFailureCount: 1 })).toBe(true);
      expect(resolveConnectionCooldownMs({ status: 429, errorText: msg, cooldownMs: 1000 })).toBeGreaterThanOrEqual(5000);
    }
  });

  it("locks a connection after two recent preflight timeouts", () => {
    const msg = "Upstream first productive timeout";
    expect(shouldLockConnectionForError({ status: 502, errorText: msg, recentFailureCount: 1 })).toBe(false);
    expect(shouldLockConnectionForError({ status: 502, errorText: msg, recentFailureCount: 2 })).toBe(true);
    expect(resolveConnectionCooldownMs({ status: 502, errorText: msg, cooldownMs: 1000, recentFailureCount: 2 })).toBeGreaterThan(1000);
  });
});
