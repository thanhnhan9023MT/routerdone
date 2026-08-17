import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { setConsoleLogRetentionMs } from "@/lib/consoleLogBuffer";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, ...safeSettings } = settings;
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    if (Object.prototype.hasOwnProperty.call(body, "consoleLogRetentionMs")) {
      const value = Number(body.consoleLogRetentionMs);
      if (!Number.isFinite(value) || value < 0 || value > 24 * 60 * 60 * 1000) {
        return NextResponse.json({ error: "Invalid console log retention" }, { status: 400 });
      }
      body.consoleLogRetentionMs = value;
    }

    // Vision Bridge (Tools tab) — validate the 4 settings surfaced in the UI.
    // Only free-tier vision models are allowed so the toggle can't be used to
    // route vision spend through paid Claude/Gemini/GPT endpoints.
    if (Object.prototype.hasOwnProperty.call(body, "visionPreprocessingEnabled")) {
      body.visionPreprocessingEnabled = body.visionPreprocessingEnabled === true;
    }
    if (Object.prototype.hasOwnProperty.call(body, "visionPreprocessingModel")) {
      const allowedVisionModels = [
        "combo:vision",
        "oc/mimo-v2.5-free",
        "oc/deepseek-v4-flash-free",
        "oc/glm-5.2",
      ];
      if (!allowedVisionModels.includes(body.visionPreprocessingModel)) {
        return NextResponse.json({ error: "Vision model must be a free-tier model" }, { status: 400 });
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "visionMaxTokens")) {
      const allowedBudgets = [1024, 2048, 4096];
      const budget = Number(body.visionMaxTokens);
      if (!allowedBudgets.includes(budget)) {
        return NextResponse.json({ error: "Invalid vision max tokens (allowed: 1024, 2048, 4096)" }, { status: 400 });
      }
      body.visionMaxTokens = budget;
    }
    if (Object.prototype.hasOwnProperty.call(body, "visionUiUxOverride")) {
      body.visionUiUxOverride = body.visionUiUxOverride === true;
    }

    if (Object.prototype.hasOwnProperty.call(body, "headroomAdaptive")) {
      const cfg = body.headroomAdaptive;
      const defaults = {
        enabled: true,
        softThresholdPercent: 70,
        mandatoryThresholdPercent: 85,
        compactThresholdPercent: 95,
        softTimeoutMs: 1500,
        mandatoryTimeoutMs: 3000,
      };
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return NextResponse.json({ error: "Invalid Headroom adaptive settings" }, { status: 400 });
      }
      const next = { ...defaults, ...cfg };
      const thresholds = [next.softThresholdPercent, next.mandatoryThresholdPercent, next.compactThresholdPercent].map(Number);
      const timeouts = [next.softTimeoutMs, next.mandatoryTimeoutMs].map(Number);
      if (typeof next.enabled !== "boolean"
        || thresholds.some((value) => !Number.isSafeInteger(value) || value < 50 || value > 99)
        || !(thresholds[0] < thresholds[1] && thresholds[1] < thresholds[2])
        || timeouts.some((value) => !Number.isSafeInteger(value) || value < 500 || value > 5000)) {
        return NextResponse.json({ error: "Invalid Headroom adaptive settings" }, { status: 400 });
      }
      body.headroomAdaptive = {
        enabled: next.enabled,
        softThresholdPercent: thresholds[0],
        mandatoryThresholdPercent: thresholds[1],
        compactThresholdPercent: thresholds[2],
        softTimeoutMs: timeouts[0],
        mandatoryTimeoutMs: timeouts[1],
      };
    }

    if (Object.prototype.hasOwnProperty.call(body, "responsesCompactionEnabled") || Object.prototype.hasOwnProperty.call(body, "responsesCompactionThresholdTokens")) {
      const enabled = body.responsesCompactionEnabled === true;
      const threshold = Number(body.responsesCompactionThresholdTokens ?? 81000);
      if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 10000000) {
        return NextResponse.json({ error: "Invalid Responses compaction settings" }, { status: 400 });
      }
      body.responsesCompactionEnabled = enabled;
      body.responsesCompactionThresholdTokens = threshold;
    }
    if (Object.prototype.hasOwnProperty.call(body, "headroomCompressModel")) {
      if (typeof body.headroomCompressModel !== "string" || body.headroomCompressModel.length > 200) {
        return NextResponse.json({ error: "Invalid Headroom compression model" }, { status: 400 });
      }
      body.headroomCompressModel = body.headroomCompressModel.trim();
    }

    if (Object.prototype.hasOwnProperty.call(body, "routerDoneContextBackup")) {
      const cfg = body.routerDoneContextBackup;
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return NextResponse.json({ error: "Invalid context backup settings" }, { status: 400 });
      }
      const threshold = Number(cfg.thresholdTokens ?? 45000);
      const retain = Number(cfg.retainRecentTurns ?? 3);
      if (typeof cfg.enabled !== "boolean" || !Number.isSafeInteger(threshold) || threshold < 36000 || !Number.isInteger(retain) || retain < 1 || retain > 6 || (cfg.codexConnectionId !== undefined && typeof cfg.codexConnectionId !== "string") || (cfg.compressModel !== undefined && (typeof cfg.compressModel !== "string" || cfg.compressModel.length > 200)) || (cfg.compressFallbackModel !== undefined && (typeof cfg.compressFallbackModel !== "string" || cfg.compressFallbackModel.length > 200))) {
        return NextResponse.json({ error: "Invalid context backup settings" }, { status: 400 });
      }
      body.routerDoneContextBackup = {
        enabled: cfg.enabled,
        thresholdTokens: threshold,
        retainRecentTurns: retain,
        codexConnectionId: cfg.codexConnectionId || "",
        compressModel: typeof cfg.compressModel === "string" ? cfg.compressModel.trim() : "",
        compressFallbackModel: typeof cfg.compressFallbackModel === "string" ? cfg.compressFallbackModel.trim() : "",
      };
    }

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    // Validate modelRedirects is a plain object of string -> string
    if (Object.prototype.hasOwnProperty.call(body, "modelRedirects")) {
      const redirects = body.modelRedirects;
      if (redirects !== null && typeof redirects === "object" && !Array.isArray(redirects)) {
        const cleaned = {};
        for (const [key, val] of Object.entries(redirects)) {
          if (typeof key === "string" && typeof val === "string" && key.trim() && val.trim()) {
            cleaned[key.trim()] = val.trim();
          }
        }
        body.modelRedirects = cleaned;
      } else {
        delete body.modelRedirects;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "consoleLogRetentionMs")) {
      setConsoleLogRetentionMs(settings.consoleLogRetentionMs);
    }

    // Apply errorFix overrides immediately (self-heal / cooldown / ban thresholds)
    if (Object.prototype.hasOwnProperty.call(body, "errorFix")) {
      try {
        const { setErrorFixConfig } = await import("open-sse/config/errorConfig.js");
        setErrorFixConfig(settings.errorFix || null);
      } catch { /* errorFix hot-reload is best-effort */ }
    }

    const { password, ...safeSettings } = settings;
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
