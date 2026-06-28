import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockOsState = vi.hoisted(() => ({ home: "" }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, homedir: vi.fn(() => mockOsState.home) },
    homedir: vi.fn(() => mockOsState.home),
  };
});

let GET;
let tempHome;

function cursorDbPathFor(platform) {
  if (platform === "darwin") {
    return path.join(tempHome, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  }
  if (platform === "linux") {
    return path.join(tempHome, ".config/Cursor/User/globalStorage/state.vscdb");
  }
  return path.join(tempHome, "AppData/Roaming/Cursor/User/globalStorage/state.vscdb");
}

function createCursorDb(platform, rows) {
  const dbPath = cursorDbPathFor(platform);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("CREATE TABLE itemTable (key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT INTO itemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  db.close();
  return dbPath;
}

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "routerdone-cursor-home-"));
    mockOsState.home = tempHome;
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    vi.resetModules();
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    if (tempHome) {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {
        // Windows can keep sqlite handles briefly after tests finish.
      }
    }
  });

  it("returns checked locations when no macOS cursor db paths are accessible", async () => {
    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found. Checked locations:");
    expect(response.body.error).toContain("Cursor");
    expect(response.body.error).toContain("globalStorage");
  });

  it("extracts tokens using exact keys", async () => {
    createCursorDb("darwin", {
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });

    const response = await GET();

    expect(response.body).toEqual({
      found: true,
      accessToken: "test-token",
      machineId: "test-machine-id",
    });
  });

  it("unwraps JSON-encoded string values", async () => {
    createCursorDb("darwin", {
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  it("returns manual fallback when exact token keys are missing", async () => {
    createCursorDb("darwin", {
      "cursorAuth/someOtherAccessTokenKey": "fallback-token",
      "storage.someMachineId": "fallback-machine",
    });

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toBeTruthy();
  });

  it("linux reports checked config locations when db paths are inaccessible", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found. Checked locations:");
    expect(response.body.error).toContain(".config");
  });

  it("linux requires Cursor install marker before importing an existing db", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    createCursorDb("linux", {
      "cursorAuth/accessToken": "linux-token",
      "storage.serviceMachineId": "linux-machine",
    });

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor config files found but Cursor IDE does not appear to be installed");
  });

  it("non-darwin/win32/linux platforms use linux-style fallback paths", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found. Checked locations:");
  });
});