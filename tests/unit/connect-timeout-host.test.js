import { describe, it, expect } from "vitest";
import { connectTimeoutForHost, FETCH_CONNECT_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";
import { hostOf } from "../../open-sse/utils/upstreamHost.js";

// `fetch connect timeout` → 502 trên node NVIDIA (2026-08-17). Đây KHÔNG phải lỗi mạng:
// nó là guard của executors/base.js — abort nếu upstream không trả HEADER trong
// FETCH_CONNECT_TIMEOUT_MS (prod đặt 30000 qua runtime_config).
//
// Đo thật, tính đúng lúc promise fetch resolve (header về), không phải byte body đầu:
//   integrate.api.nvidia.com · z-ai/glm-5.2 · stream:true  → header sau 28,9s
//   integrate.api.nvidia.com · z-ai/glm-5.2 · stream:false → header sau 41,9s
// So với trần 30s thì đó là tung xúc xắc — gọi tuần tự lúc 200 lúc 502. Và ĐỒNG THỜI
// KHÔNG phải nguyên nhân: TTFB 5 luồng trung bình 41,2s còn 30 luồng 37,9s.
describe("connectTimeoutForHost", () => {
  it("nâng trần cho host NVIDIA", () => {
    const ms = connectTimeoutForHost("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(ms).toBeGreaterThan(FETCH_CONNECT_TIMEOUT_MS);
    // phải dư trên mức xấu nhất đo được (41,9s), nếu không là vá nửa vời
    expect(ms).toBeGreaterThan(42000);
  });

  it("host khác KHÔNG bị ảnh hưởng → giữ trần chặt để failover nhanh", () => {
    for (const u of [
      "https://api.openai.com/v1/chat/completions",
      "https://api.anthropic.com/v1/messages",
      "http://127.0.0.1:4001/v1/chat/completions",
      "https://ohhmyagent.com/v1/messages",
    ]) {
      expect(connectTimeoutForHost(u)).toBeNull();
    }
  });

  it("khớp cả sub-host, KHÔNG khớp host chỉ chứa chuỗi tương tự", () => {
    expect(connectTimeoutForHost("https://integrate.api.nvidia.com/v1")).not.toBeNull();
    expect(connectTimeoutForHost("https://api.nvidia.com/v1")).not.toBeNull();
    // Chống khớp lỏng: tên miền của người khác chỉ tình cờ chứa "api.nvidia.com"
    expect(connectTimeoutForHost("https://api.nvidia.com.evil.example/v1")).toBeNull();
    expect(connectTimeoutForHost("https://notapi.nvidia.com.co/v1")).toBeNull();
  });

  it("đầu vào rác trả null, không nổ", () => {
    for (const u of [null, undefined, "", "   ", "/v1/chat/completions", "::::", 42, {}]) {
      expect(connectTimeoutForHost(u)).toBeNull();
    }
  });

  it("chuẩn hoá host: thiếu scheme và dấu chấm cuối vẫn khớp", () => {
    // Hai dạng này từng làm luật theo host âm thầm KHÔNG khớp (im lặng, không lỗi).
    expect(connectTimeoutForHost("integrate.api.nvidia.com/v1/chat/completions")).not.toBeNull();
    expect(connectTimeoutForHost("https://integrate.api.nvidia.com./v1")).not.toBeNull();
  });
});

describe("hostOf", () => {
  it("bóc hostname từ các dạng URL thật", () => {
    expect(hostOf("https://Integrate.API.NVIDIA.com/v1")).toBe("integrate.api.nvidia.com");
    expect(hostOf("host.com:8080/v1")).toBe("host.com");
    expect(hostOf("https://host.com./v1")).toBe("host.com");
    expect(hostOf("http://127.0.0.1:4001/v1")).toBe("127.0.0.1");
  });

  it("đường dẫn tương đối KHÔNG được đoán origin", () => {
    // Đoán origin cho path tương đối là áp luật của upstream khác lên một upstream lạ.
    expect(hostOf("/v1/chat/completions")).toBe("");
  });

  it("đầu vào không dùng được trả chuỗi rỗng", () => {
    for (const v of [null, undefined, "", "   ", 42, {}, []]) expect(hostOf(v)).toBe("");
  });
});
