import { describe, expect, it } from "vitest";

import { BaseExecutor } from "../../open-sse/executors/base.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getTargetFormat } from "../../open-sse/services/provider.js";

const responseIdProvider = "openai-compatible-responses-82e48ab8-0a14-44b3-aa8e-3330e5b2295e";
const baseUrl = "https://api.vietapi.tech/v1";

function credentials(apiType) {
  return {
    apiKey: "test-key",
    providerSpecificData: apiType
      ? { apiType, baseUrl }
      : { baseUrl },
  };
}

describe("OpenAI-compatible apiType routing", () => {
  it("routes edited responses-node providers to Chat Completions when apiType is chat", () => {
    const creds = credentials("chat");
    const base = new BaseExecutor(responseIdProvider, {});
    const executor = new DefaultExecutor(responseIdProvider);

    expect(getTargetFormat(responseIdProvider, creds)).toBe("openai");
    expect(base.buildUrl("gpt-5.5-xhigh", true, 0, creds)).toBe(`${baseUrl}/chat/completions`);
    expect(executor.buildUrl("gpt-5.5-xhigh", true, 0, creds)).toBe(`${baseUrl}/chat/completions`);
  });

  it("keeps Responses API routing when apiType is responses", () => {
    const creds = credentials("responses");
    const base = new BaseExecutor(responseIdProvider, {});
    const executor = new DefaultExecutor(responseIdProvider);

    expect(getTargetFormat(responseIdProvider, creds)).toBe("openai-responses");
    expect(base.buildUrl("gpt-5.5-xhigh", true, 0, creds)).toBe(`${baseUrl}/responses`);
    expect(executor.buildUrl("gpt-5.5-xhigh", true, 0, creds)).toBe(`${baseUrl}/responses`);
  });

  it("normalizes explicit LM Studio connection transport only", () => {
    const creds = {
      apiKey: "test-key",
      providerSpecificData: { baseUrl: "http://127.0.0.1:1234", runtimeProfile: "lmstudio_local", apiType: "chat" },
    };
    const base = new BaseExecutor(responseIdProvider, {});
    const executor = new DefaultExecutor(responseIdProvider);

    expect(base.buildUrl("local-model", true, 0, creds)).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(executor.buildUrl("local-model", true, 0, creds)).toBe("http://127.0.0.1:1234/v1/chat/completions");
  });

  it("falls back to provider id routing for legacy connections without apiType", () => {
    const creds = credentials(null);
    const base = new BaseExecutor(responseIdProvider, {});
    const executor = new DefaultExecutor(responseIdProvider);

    expect(getTargetFormat(responseIdProvider, creds)).toBe("openai-responses");
    expect(base.buildUrl("gpt-5.5-xhigh", true, 0, creds)).toBe(`${baseUrl}/responses`);
    expect(executor.buildUrl("gpt-5.5-xhigh", true, 0, creds)).toBe(`${baseUrl}/responses`);
  });

});
