import { describe, it, expect } from "vitest";

import { isClientPayloadError, checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("client-payload 400 classification (no account/model lock)", () => {
  it("treats an xai grok unsupported-parameter 400 as a client error", () => {
    const err = '{"code":"invalid-argument","error":"Model grok-4.5 does not support parameter presencePenalty."}';
    expect(isClientPayloadError(400, err)).toBe(true);

    const r = checkFallbackError(400, err);
    expect(r.clientError).toBe(true);
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("does not misclassify genuine 5xx or unrelated 400s as client payload errors", () => {
    expect(isClientPayloadError(502, "bad gateway")).toBe(false);
    expect(isClientPayloadError(500, "do request failed")).toBe(false);
    expect(isClientPayloadError(400, "some unrelated bad request")).toBe(false);
  });
});
