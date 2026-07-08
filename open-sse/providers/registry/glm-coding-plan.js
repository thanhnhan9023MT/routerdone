import { CLAUDE_API_HEADERS } from "../shared.js";

// Dormant provider: routes through a local (or internal-network) zcodedone sidecar
// to reach the ZCode Coding Plan 1.5x-quota endpoint (zcode.z.ai/api/v1/zcode-plan/...).
// The zcodedone sidecar handles JWT coding-plan auth + Aliyun captcha +
// multi-account rotation.
// Without the sidecar running and ZCODE_GATEWAY_KEY matching, this provider is inert.
// See docs/ZCODE_PLAN.md for deployment + owner-only setup.
const SIDECAR_URL =
  process.env.ZCODE_SIDECAR_URL || "http://127.0.0.1:3000/v1/messages";

export default {
  id: "glm-coding-plan",
  priority: 125,
  alias: "glm-coding-plan",
  display: {
    name: "GLM Coding Plan (Sidecar)",
    icon: "code",
    color: "#7C3AED",
    textIcon: "GP",
    website: "https://zcode.z.ai",
    notice: {
      apiKeyUrl: "https://zcode.z.ai",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: SIDECAR_URL,
    format: "claude",
    headers: { ...CLAUDE_API_HEADERS },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5", name: "GLM 5" },
    { id: "glm-4.7", name: "GLM 4.7" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo" },
  ],
};
