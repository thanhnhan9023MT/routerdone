"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardSkeleton, Toggle, Select } from "@/shared/components";

// Free vision models available on the opencode-go provider, plus a special
// "combo:vision" option that reads the model from the "vision" combo in the
// Combos tab — so the user manages the vision model in one place.
const VISION_MODEL_OPTIONS = [
  { value: "combo:vision", label: "Combo: vision (tự động theo combo)" },
  { value: "oc/mimo-v2.5-free", label: "Mimo V2.5 (Free)" },
  { value: "oc/deepseek-v4-flash-free", label: "DeepSeek V4 Flash (Free)" },
  { value: "oc/glm-5.2", label: "GLM 5.2" },
];

const VISION_MAX_TOKENS_OPTIONS = [
  { value: 1024, label: "1024 tokens" },
  { value: 2048, label: "2048 tokens" },
  { value: 4096, label: "4096 tokens" },
];

export default function ToolsPageClient() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [visionPreprocessingEnabled, setVisionPreprocessingEnabled] = useState(true);
  const [visionPreprocessingModel, setVisionPreprocessingModel] = useState("combo:vision");
  const [visionMaxTokens, setVisionMaxTokens] = useState(1024);
  const [visionUiUxOverride, setVisionUiUxOverride] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load settings");
      const data = await res.json();
      setVisionPreprocessingEnabled(data.visionPreprocessingEnabled !== false);
      setVisionPreprocessingModel(data.visionPreprocessingModel || "combo:vision");
      setVisionMaxTokens(
        typeof data.visionMaxTokens === "number" ? data.visionMaxTokens : 1024
      );
      setVisionUiUxOverride(data.visionUiUxOverride === true);
    } catch (err) {
      console.log("Error loading settings:", err);
      setError(err.message || "Could not load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const patchSetting = useCallback(async (patch) => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update setting");
      }
      return true;
    } catch (err) {
      console.log("Error updating setting:", err);
      setError(err.message || "Could not save setting");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const handleEnabled = async (value) => {
    const prev = visionPreprocessingEnabled;
    setVisionPreprocessingEnabled(value);
    const ok = await patchSetting({ visionPreprocessingEnabled: value });
    if (!ok) setVisionPreprocessingEnabled(prev);
  };

  const handleModel = async (event) => {
    const value = event?.target?.value || "combo:vision";
    // Defensive: only accept models from the allowlist.
    const safe = VISION_MODEL_OPTIONS.some((o) => o.value === value)
      ? value
      : VISION_MODEL_OPTIONS[0].value;
    const prev = visionPreprocessingModel;
    setVisionPreprocessingModel(safe);
    const ok = await patchSetting({ visionPreprocessingModel: safe });
    if (!ok) setVisionPreprocessingModel(prev);
  };

  const handleMaxTokens = async (event) => {
    const raw = Number(event?.target?.value);
    const safe = VISION_MAX_TOKENS_OPTIONS.some((o) => Number(o.value) === raw)
      ? raw
      : 1024;
    const prev = visionMaxTokens;
    setVisionMaxTokens(safe);
    const ok = await patchSetting({ visionMaxTokens: safe });
    if (!ok) setVisionMaxTokens(prev);
  };

  const handleUiUxOverride = async (value) => {
    const prev = visionUiUxOverride;
    setVisionUiUxOverride(value);
    const ok = await patchSetting({ visionUiUxOverride: value });
    if (!ok) setVisionUiUxOverride(prev);
  };

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-main">Tools</h1>
          <p className="text-sm text-text-muted">Công cụ bổ sung cho router API.</p>
        </div>
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-main">Tools</h1>
        <p className="text-sm text-text-muted">Công cụ bổ sung cho router API.</p>
      </div>

      {error && (
        <div className="rounded-[10px] border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {error}
        </div>
      )}

      <Card
        icon="visibility"
        title="Vision Bridge"
        subtitle="Tự động thêm mô tả ảnh cho các model không hỗ trợ vision."
      >
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2 border-b border-border-subtle pb-6">
            <Toggle
              checked={visionPreprocessingEnabled}
              onChange={handleEnabled}
              label="Enable Vision Polyfill"
              description="Khi bật, ảnh trong request sẽ được model vision mô tả trước khi gửi tới model đích không hỗ trợ vision. Tắt để truyền ảnh nguyên bản (model đích có thể từ chối)."
              disabled={saving}
            />
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <Select
              label="Vision Model"
              value={visionPreprocessingModel}
              onChange={handleModel}
              options={VISION_MODEL_OPTIONS}
              hint="Combo: vision tự động theo model trong tab Combos. Hoặc chọn model cụ thể."
              disabled={saving}
            />
            <Select
              label="Max Tokens"
              value={String(visionMaxTokens)}
              onChange={handleMaxTokens}
              options={VISION_MAX_TOKENS_OPTIONS.map((o) => ({
                value: String(o.value),
                label: o.label,
              }))}
              hint="Ngân sách đầu ra cho mỗi ảnh."
              disabled={saving}
            />
          </div>

          <div className="flex flex-col gap-2 border-t border-border-subtle pt-6">
            <Toggle
              checked={visionUiUxOverride}
              onChange={handleUiUxOverride}
              label="UI/UX Design Context Override"
              description="Đổi prompt sang phân tích giao diện: OCR + bối cảnh UI/UX + đề xuất ngắn. Luôn dùng 4096 tokens để không bị cắt. Tắt để dùng chế độ OCR+caption mặc định."
              disabled={saving}
            />
          </div>
        </div>
      </Card>

      <Card icon="info" title="Cách hoạt động" padding="md">
        <ul className="flex flex-col gap-2 text-sm text-text-muted">
          <li>• Khi model đích không hỗ trợ ảnh, Vision Bridge gọi model vision qua loopback để tạo mô tả text, rồi thay ảnh bằng mô tả đó.</li>
          <li>• Kết quả được cache 6 giờ theo model + chế độ prompt, nên toggle UI/UX sẽ sinh mô tả mới thay vì dùng cache cũ.</li>
          <li>• Model vision mặc định theo combo "vision" trong tab Combos — đổi combo là Vision Bridge tự theo. Cũng có thể chọn model cụ thể.</li>
        </ul>
      </Card>
    </div>
  );
}
