import { describe, it, expect, vi, beforeEach } from "vitest";

const connection = {
  id: "codex-conn-1",
  provider: "codex",
  authType: "oauth",
  isActive: true,
  accessToken: "access-token",
  refreshToken: null,
  providerSpecificData: {},
};

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getUsageForProvider: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getExecutor: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: mocks.getExecutor,
}));

describe("Codex usage auth failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue({ ...connection });
    mocks.updateProviderConnection.mockResolvedValue(null);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.getExecutor.mockReturnValue({
      needsRefresh: () => false,
      refreshCredentials: vi.fn(),
    });
  });

  it("turns off a Codex account when quota usage returns 401 unavailable", async () => {
    mocks.getUsageForProvider.mockResolvedValue({
      message: "Codex connected. Usage API temporarily unavailable (401).",
    });

    const { fetchConnectionUsage } = await import("../../src/app/api/usage/_shared.js");
    const result = await fetchConnectionUsage(connection.id);

    expect(result.ok).toBe(true);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      connection.id,
      expect.objectContaining({
        isActive: false,
        testStatus: "auth_error",
        lastError: "Codex connected. Usage API temporarily unavailable (401).",
        errorCode: "usage_api_401",
      }),
    );
    expect(mocks.updateProviderConnection.mock.calls[0][1].lastErrorAt).toEqual(expect.any(String));
  });

  it("does not turn off Codex for temporary non-auth quota failures", async () => {
    mocks.getUsageForProvider.mockResolvedValue({
      message: "Codex connected. Usage API temporarily unavailable (503).",
    });

    const { fetchConnectionUsage } = await import("../../src/app/api/usage/_shared.js");
    await fetchConnectionUsage(connection.id);

    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});