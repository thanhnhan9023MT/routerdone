import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB-backed dependencies so the policy helpers can be tested in
// isolation. The helpers import getComboByName (async) and the usage tz
// helpers (sync) plus countRequestTokens (sync, pure).
vi.mock("@/lib/db", () => ({
  getComboByName: vi.fn(async (name) => {
    if (name === "helper.fallback") return { id: "c1", name, models: ["a", "b"] };
    return null;
  }),
}));

vi.mock("@/lib/db/repos/usageRepo.js", () => ({
  getUsageDateKeyPublic: vi.fn(() => "2026-07-05"),
  getUsagePeriodRange: vi.fn(() => ({ startMs: Date.UTC(2026, 6, 5), endMs: Date.now(), timeZone: "Asia/Saigon" })),
}));

// Keep the tokenizer real — countRequestTokens is pure & dependency-free.
// (No mock for open-sse/utils/tokenEstimate; let it run.)

import { checkModelAllowed, checkKeyQuota } from "@/sse/services/keyPolicy.js";

describe("checkModelAllowed", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("passes when key is null (local mode / CLI token)", async () => {
    const r = await checkModelAllowed("gpt-5", null);
    expect(r.allowed).toBe(true);
  });

  it("passes for type=all regardless of model", async () => {
    const r = await checkModelAllowed("anything", { allowedModels: { type: "all", value: null } });
    expect(r.allowed).toBe(true);
  });

  it("passes for type=model when model matches exactly", async () => {
    const r = await checkModelAllowed("gpt-5", { allowedModels: { type: "model", value: "gpt-5" } });
    expect(r.allowed).toBe(true);
  });

  it("denies for type=model when model differs", async () => {
    const r = await checkModelAllowed("claude-opus", { allowedModels: { type: "model", value: "gpt-5" } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("model_not_allowed");
    expect(r.detail).toContain("gpt-5");
  });

  it("passes for type=combo when request targets the exact combo name", async () => {
    const r = await checkModelAllowed("helper.fallback", { allowedModels: { type: "combo", value: "helper.fallback" } });
    expect(r.allowed).toBe(true);
  });

  it("denies for type=combo when request is a single model", async () => {
    const r = await checkModelAllowed("gpt-5", { allowedModels: { type: "combo", value: "helper.fallback" } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("model_not_allowed");
  });

  it("denies for type=combo when configured combo no longer exists", async () => {
    const r = await checkModelAllowed("ghost.combo", { allowedModels: { type: "combo", value: "ghost.combo" } });
    expect(r.allowed).toBe(false);
    expect(r.detail).toContain("no longer exists");
  });

  it("treats missing policy as type=all (back-compat)", async () => {
    const r = await checkModelAllowed("anything", { allowedModels: null });
    expect(r.allowed).toBe(true);
  });
});

describe("checkKeyQuota", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("passes when key is null", () => {
    expect(checkKeyQuota(null, { body: { messages: [{ role: "user", content: "hi" }] } }).allowed).toBe(true);
  });

  it("passes for unlimited keys", () => {
    const r = checkKeyQuota(
      { limitType: "unlimited", tokenLimit: 0, usedTokens: 999999 },
      { body: { messages: [{ role: "user", content: "hi" }] } }
    );
    expect(r.allowed).toBe(true);
  });

  it("passes for total when limit is 0 (unset)", () => {
    const r = checkKeyQuota(
      { limitType: "total", tokenLimit: 0, usedTokens: 100 },
      { body: { messages: [{ role: "user", content: "hi" }] } }
    );
    expect(r.allowed).toBe(true);
  });

  it("denies for total when used + estInput exceeds limit", () => {
    // 4 chars "test" ~ small estimate; used already at limit -> deny.
    const r = checkKeyQuota(
      { limitType: "total", tokenLimit: 1000, usedTokens: 1000 },
      { body: { messages: [{ role: "user", content: "test" }] } }
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("quota_exceeded");
    expect(r.limit).toBe(1000);
    expect(r.used).toBe(1000);
  });

  it("passes for total when there is still headroom", () => {
    const r = checkKeyQuota(
      { limitType: "total", tokenLimit: 1_000_000, usedTokens: 100 },
      { body: { messages: [{ role: "user", content: "test" }] } }
    );
    expect(r.allowed).toBe(true);
  });

  it("daily resets when cached dateKey is stale", () => {
    // usedDailyDateKey from yesterday -> effective used = 0 -> pass.
    const r = checkKeyQuota(
      { limitType: "daily", tokenLimit: 1000, usedDailyTokens: 5000, usedDailyDateKey: "2026-07-01" },
      { body: { messages: [{ role: "user", content: "test" }] } }
    );
    expect(r.allowed).toBe(true);
  });

  it("daily denies when same-day usage is at limit", () => {
    const r = checkKeyQuota(
      { limitType: "daily", tokenLimit: 1000, usedDailyTokens: 1000, usedDailyDateKey: "2026-07-05" },
      { body: { messages: [{ role: "user", content: "test" }] } }
    );
    expect(r.allowed).toBe(false);
    expect(r.resetAt).toBeTruthy(); // daily carries a resetAt hint
  });

  it("fail-open when body is missing (treats estInput as 0)", () => {
    const r = checkKeyQuota(
      { limitType: "total", tokenLimit: 1000, usedTokens: 1000 },
      {}
    );
    // used(1000) + 0 == limit, NOT > limit -> still allowed (boundary).
    expect(r.allowed).toBe(true);
  });
});
