"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";

// Modal to configure a single API key's quota + model restriction policy.
// Parent remounts this component with key={keyRecord?.id} so initial state is
// derived from props once per opened key — no hydrate-from-props effect.
// Props:
//   isOpen, onClose, keyRecord (the apiKeys row), onSaved (callback after PUT)
// Fetches /v1/models (for the model dropdown) and /api/combos (for combos).
export default function KeyLimitModal({ isOpen, onClose, keyRecord, onSaved }) {
  const [limitType, setLimitType] = useState(keyRecord?.limitType || "unlimited"); // unlimited | total | daily
  const [tokenLimit, setTokenLimit] = useState(
    typeof keyRecord?.tokenLimit === "number" && keyRecord.tokenLimit > 0
      ? String(keyRecord.tokenLimit)
      : ""
  );
  const [allowedType, setAllowedType] = useState(keyRecord?.allowedModels?.type || "all"); // all | model | combo
  const [allowedValue, setAllowedValue] = useState(keyRecord?.allowedModels?.value || "");
  const [models, setModels] = useState([]);
  const [combos, setCombos] = useState([]);
  // When true, the "specific model" picker shows a free-text input instead of the
  // <select>. Used for model names not exposed by /v1/models (CLI tool wire names,
  // custom/aliased models, or when no provider is connected and /v1/models is empty).
  const [customModelMode, setCustomModelMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");

  // Load model + combo options once when first opened.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const [modelsRes, combosRes] = await Promise.all([
          fetch("/v1/models").then((r) => r.json()).catch(() => ({ data: [] })),
          fetch("/api/combos").then((r) => r.json()).catch(() => ({ combos: [] })),
        ]);
        if (cancelled) return;
        const modelIds = (modelsRes?.data || []).map((m) => m.id).filter(Boolean).sort();
        setModels(modelIds);
        const comboNames = (combosRes?.combos || []).map((c) => c.name).filter(Boolean).sort();
        setCombos(comboNames);
        // Auto-fall-back to custom-mode when the saved value is non-empty but
        // missing from /v1/models (disconnected provider, custom/aliased model,
        // CLI wire name). Prevents the <select> from silently dropping the value.
        if (
          allowedType === "model" &&
          allowedValue &&
          modelIds.length > 0 &&
          !modelIds.includes(allowedValue)
        ) {
          setCustomModelMode(true);
        }
      } catch {
        // Options are best-effort; user can still type the value manually.
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  if (!keyRecord) return null;

  const usedTokens = keyRecord.usedTokens || 0;
  const usedDailyTokens = keyRecord.usedDailyTokens || 0;
  const limitNum = Number(tokenLimit) || 0;
  const effectiveUsed = limitType === "total" ? usedTokens : limitType === "daily" ? usedDailyTokens : 0;
  const pct = limitNum > 0 ? Math.min(100, Math.round((effectiveUsed / limitNum) * 100)) : 0;

  async function handleSave() {
    setError("");
    if (limitType !== "unlimited") {
      if (!Number.isFinite(Number(tokenLimit)) || Number(tokenLimit) <= 0) {
        setError("Token limit must be a positive number.");
        return;
      }
    }
    if (allowedType !== "all" && !allowedValue.trim()) {
      setError(`Please pick a ${allowedType}.`);
      return;
    }
    setSaving(true);
    try {
      const body = {
        limitType,
        tokenLimit: limitType === "unlimited" ? 0 : Math.floor(Number(tokenLimit)),
        allowedModels: {
          type: allowedType,
          value: allowedType === "all" ? null : allowedValue.trim(),
        },
      };
      const res = await fetch(`/api/keys/${keyRecord.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update key");
      }
      const data = await res.json();
      if (onSaved) onSaved(data.key);
      onClose();
    } catch (e) {
      setError(e.message || "Failed to update key");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(scope) {
    setError("");
    setResetting(true);
    try {
      const res = await fetch(`/api/keys/${keyRecord.id}/reset-usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to reset usage");
      }
      const data = await res.json();
      if (onSaved) onSaved(data.key);
    } catch (e) {
      setError(e.message || "Failed to reset usage");
    } finally {
      setResetting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      title={`Configure Key — ${keyRecord.name || "API Key"}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        {/* Quota section */}
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Token Quota</p>
          <div className="flex flex-col gap-2">
            {[
              { v: "unlimited", label: "Unlimited" },
              { v: "total", label: "Total tokens (lifetime)" },
              { v: "daily", label: "Daily tokens (reset at local midnight)" },
            ].map((opt) => (
              <label key={opt.v} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="limitType"
                  checked={limitType === opt.v}
                  onChange={() => setLimitType(opt.v)}
                  className="accent-[var(--color-primary,#4f7cff)]"
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
          {limitType !== "unlimited" && (
            <Input
              label="Token limit (prompt + completion)"
              type="number"
              min="1"
              value={tokenLimit}
              onChange={(e) => setTokenLimit(e.target.value)}
              placeholder="e.g. 50000"
            />
          )}
          {limitType !== "unlimited" && limitNum > 0 && (
            <div className="text-xs text-text-muted flex flex-col gap-1">
              <div className="flex justify-between">
                <span>Used: {effectiveUsed.toLocaleString()} / {limitNum.toLocaleString()} tokens</span>
                <span>{pct}%</span>
              </div>
              <div className="h-1.5 rounded bg-surface-2 overflow-hidden">
                <div
                  className={`h-full ${pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-warning" : "bg-success"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex gap-2 mt-1">
                <Button size="sm" variant="ghost" disabled={resetting} onClick={() => handleReset(limitType)}>
                  Reset {limitType} counter
                </Button>
                <Button size="sm" variant="ghost" disabled={resetting} onClick={() => handleReset("all")}>
                  Reset all
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Model restriction section */}
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Allowed Models</p>
          <div className="flex flex-col gap-2">
            {[
              { v: "all", label: "All models & combos" },
              { v: "model", label: "Specific model only" },
              { v: "combo", label: "Specific combo only" },
            ].map((opt) => (
              <label key={opt.v} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="allowedType"
                  checked={allowedType === opt.v}
                  onChange={() => { setAllowedType(opt.v); setAllowedValue(""); setCustomModelMode(false); }}
                  className="accent-[var(--color-primary,#4f7cff)]"
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
          {allowedType === "model" && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label className="text-xs text-text-muted">Model name</label>
                <button
                  type="button"
                  onClick={() => {
                    setCustomModelMode((v) => !v);
                    setAllowedValue("");
                  }}
                  className="text-xs text-primary underline hover:opacity-80"
                >
                  {customModelMode ? "Pick from list" : "Enter custom name…"}
                </button>
              </div>
              {customModelMode ? (
                <Input
                  type="text"
                  value={allowedValue}
                  onChange={(e) => setAllowedValue(e.target.value)}
                  placeholder="e.g. gpt-5, claude-sonnet-4-5"
                />
              ) : (
                <>
                  <select
                    value={allowedValue}
                    onChange={(e) => setAllowedValue(e.target.value)}
                    className="px-3 py-2 rounded-lg bg-surface-2 border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="">— pick a model —</option>
                    {models.map((m) => (<option key={m} value={m}>{m}</option>))}
                  </select>
                  {models.length === 0 && (
                    <p className="text-xs text-text-muted">
                      No models available from your provider connections.{" "}
                      <button
                        type="button"
                        onClick={() => setCustomModelMode(true)}
                        className="text-primary underline hover:opacity-80"
                      >
                        Enter a custom model name instead
                      </button>.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {allowedType === "combo" && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-muted">Combo name</label>
              <select
                value={allowedValue}
                onChange={(e) => setAllowedValue(e.target.value)}
                className="px-3 py-2 rounded-lg bg-surface-2 border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">— pick a combo —</option>
                {combos.map((c) => (<option key={c} value={c}>{c}</option>))}
              </select>
              {combos.length === 0 && (
                <p className="text-xs text-text-muted">No combos defined. Create one in the Combos page first.</p>
              )}
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

KeyLimitModal.propTypes = {
  isOpen: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  keyRecord: PropTypes.object,
  onSaved: PropTypes.func,
};
