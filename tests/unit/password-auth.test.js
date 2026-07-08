import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// Mock settings so we can control stored hash without touching a real DB.
const settingsState = { password: null };
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ ...settingsState }),
}));

import {
  isPasswordFromEnvMode,
  getEnvPassword,
  verifyPassword,
  isUsingDefaultPassword,
} from "@/lib/auth/passwordAuth";

function setEnv(env) {
  for (const k of ["PASSWORD_FROM_ENV", "INITIAL_PASSWORD"]) delete process.env[k];
  Object.assign(process.env, env);
}

afterEach(() => {
  settingsState.password = null;
  setEnv({});
});

describe("passwordAuth — legacy mode (PASSWORD_FROM_ENV unset)", () => {
  beforeEach(() => setEnv({}));

  it("uses default '123456' when no hash and no env", async () => {
    expect(await verifyPassword("123456")).toBe(true);
    expect(await verifyPassword("anything")).toBe(false);
  });

  it("uses INITIAL_PASSWORD when set but no hash stored yet", async () => {
    setEnv({ INITIAL_PASSWORD: "passcuaban" });
    expect(await verifyPassword("passcuaban")).toBe(true);
    expect(await verifyPassword("123456")).toBe(false);
  });

  it("DB hash takes precedence over INITIAL_PASSWORD env", async () => {
    // bcrypt hash for "oldpass" — precomputed so the test stays sync-free.
    const hash = await (await import("bcryptjs")).hash("oldpass", 10);
    settingsState.password = hash;
    setEnv({ INITIAL_PASSWORD: "passcuaban" });
    expect(await verifyPassword("oldpass")).toBe(true);
    expect(await verifyPassword("passcuaban")).toBe(false); // env ignored when hash present
  });

  it("isUsingDefaultPassword true only when no hash AND no env", async () => {
    expect(await isUsingDefaultPassword()).toBe(true);
    setEnv({ INITIAL_PASSWORD: "x" });
    expect(await isUsingDefaultPassword()).toBe(true); // still no hash → still "default" branch
    settingsState.password = "fakehash";
    expect(await isUsingDefaultPassword()).toBe(false);
  });
});

describe("passwordAuth — env precedence mode (PASSWORD_FROM_ENV=true)", () => {
  beforeEach(() => setEnv({ PASSWORD_FROM_ENV: "true" }));

  it("env password wins even when DB has a hash", async () => {
    settingsState.password = "$2a$10$somehashthatwontmatchanything";
    setEnv({ PASSWORD_FROM_ENV: "true", INITIAL_PASSWORD: "passcuaban" });
    expect(await verifyPassword("passcuaban")).toBe(true);
    // The stale DB hash is ignored — this is the Dokploy fix.
    expect(await verifyPassword("anything-else")).toBe(false);
  });

  it("falls back to default 123456 when INITIAL_PASSWORD not set in env mode", async () => {
    setEnv({ PASSWORD_FROM_ENV: "true" });
    expect(await verifyPassword("123456")).toBe(true);
    expect(getEnvPassword()).toBe("123456");
  });

  it("isUsingDefaultPassword is false in env mode (no force-change prompt)", async () => {
    setEnv({ PASSWORD_FROM_ENV: "true" });
    expect(await isUsingDefaultPassword()).toBe(false);
  });

  it("changing INITIAL_PASSWORD in env takes effect immediately (no DB writeback)", async () => {
    setEnv({ PASSWORD_FROM_ENV: "true", INITIAL_PASSWORD: "first" });
    expect(await verifyPassword("first")).toBe(true);
    setEnv({ PASSWORD_FROM_ENV: "true", INITIAL_PASSWORD: "second" });
    expect(await verifyPassword("second")).toBe(true);
    expect(await verifyPassword("first")).toBe(false); // old env value no longer valid
  });
});

describe("passwordAuth — flags", () => {
  it("isPasswordFromEnvMode reads the flag correctly", () => {
    setEnv({});
    expect(isPasswordFromEnvMode()).toBe(false);
    setEnv({ PASSWORD_FROM_ENV: "false" });
    expect(isPasswordFromEnvMode()).toBe(false);
    setEnv({ PASSWORD_FROM_ENV: "true" });
    expect(isPasswordFromEnvMode()).toBe(true);
  });
});
