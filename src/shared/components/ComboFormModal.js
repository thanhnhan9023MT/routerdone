"use client";

import { useState, useEffect } from "react";
import Modal from "./Modal";
import Input from "./Input";
import Button from "./Button";
import ModelSelectModal from "./ModelSelectModal";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// Inline editable model item
function ModelItem({ index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove, timeoutSec, onTimeoutChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };
  return (
    <div className="group flex min-w-0 items-center gap-1.5 rounded-md bg-black/[0.02] px-2 py-1 transition-colors hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04]">
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>
      {editing ? (
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20" />
      ) : (
        <div className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          onClick={() => setEditing(true)} title="Click to edit">{model}</div>
      )}
      <input type="number" min="1" max="300" value={timeoutSec} onChange={(e) => onTimeoutChange(e.target.value)}
        placeholder="s" title="Timeout riêng cho model này (giây); trống = mặc định combo/global"
        className="w-11 shrink-0 rounded border border-black/10 bg-white px-1 py-0.5 text-center font-mono text-[11px] text-text-main outline-none focus:border-primary dark:border-white/10 dark:bg-black/20" />
      <div className="flex shrink-0 items-center gap-0.5">
        <button onClick={onMoveUp} disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`} title="Move up">
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button onClick={onMoveDown} disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`} title="Move down">
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>
      <button onClick={onRemove} className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all" title="Remove">
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

// Reusable Combo create/edit modal. forcePrefix auto-prepends to name.
export default function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, kindFilter = null, forcePrefix = "", title }) {
  // Strip prefix when editing existing combo so user only edits suffix
  const initialName = combo?.name
    ? (forcePrefix && combo.name.startsWith(forcePrefix) ? combo.name.slice(forcePrefix.length) : combo.name)
    : "";
  const [name, setName] = useState(initialName);
  const [models, setModels] = useState(combo?.models || []);
  // Per-combo reasoning first-productive timeout, edited in SECONDS (stored as ms).
  // Blank → use the global default (120s). Only affects slow-reasoning members.
  const [reasoningTimeoutSec, setReasoningTimeoutSec] = useState(
    combo?.reasoningTimeoutMs ? String(Math.round(combo.reasoningTimeoutMs / 1000)) : ""
  );
  // Per-node stream timeout override, edited in SECONDS per model (stored as { model: ms }).
  // Blank for a model → that node uses the combo/global default.
  const [nodeTimeoutSec, setNodeTimeoutSec] = useState(() => {
    const o = {}; const nt = combo?.nodeTimeouts || {};
    for (const k in nt) o[k] = String(Math.round(nt[k] / 1000));
    return o;
  });
  // External vision handler (model ref or combo name) used for image requests.
  const [visionModel, setVisionModel] = useState(combo?.visionModel || "");
  const [pdfModel, setPdfModel] = useState(combo?.pdfModel || "");
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});

  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/models/alias").then((r) => r.ok ? r.json() : null).then((d) => d && setModelAliases(d.aliases || {})).catch(() => {});
  }, [isOpen]);

  const validateName = (value) => {
    if (!value.trim()) { setNameError("Name is required"); return false; }
    const full = forcePrefix + value;
    if (!VALID_NAME_REGEX.test(full)) { setNameError("Only letters, numbers, -, _ and . allowed"); return false; }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    let value = e.target.value;
    // If user types prefix manually, strip it (we always prepend)
    if (forcePrefix && value.startsWith(forcePrefix)) value = value.slice(forcePrefix.length);
    setName(value);
    if (value) validateName(value); else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!models.includes(model.value)) setModels([...models, model.value]);
  };
  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => m !== model.value));
  };
  const handleRemoveModel = (i) => setModels(models.filter((_, idx) => idx !== i));
  const handleMoveUp = (i) => {
    if (i === 0) return;
    const a = [...models]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; setModels(a);
  };
  const handleMoveDown = (i) => {
    if (i === models.length - 1) return;
    const a = [...models]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; setModels(a);
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    setSaving(true);
    // Seconds → ms; blank/invalid → null (server clamps to [4, 300]s).
    const trimmedSec = String(reasoningTimeoutSec).trim();
    const reasoningTimeoutMs = trimmedSec === "" || !(Number(trimmedSec) > 0)
      ? null
      : Math.round(Number(trimmedSec) * 1000);
    // Per-node timeouts (seconds → ms), only for models still in the list.
    const nodeTimeouts = {};
    for (const m of models) {
      const sec = String(nodeTimeoutSec[m] || "").trim();
      if (sec !== "" && Number(sec) > 0) nodeTimeouts[m] = Math.round(Number(sec) * 1000);
    }
    await onSave({ name: forcePrefix + name.trim(), models, reasoningTimeoutMs, visionModel: visionModel.trim() || null, pdfModel: pdfModel.trim() || null, nodeTimeouts: Object.keys(nodeTimeouts).length ? nodeTimeouts : null });
    setSaving(false);
  };

  const isEdit = !!combo;

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={title || (isEdit ? "Edit Combo" : "Create Combo")}>
        <div className="flex flex-col gap-3">
          <div>
            {forcePrefix ? (
              <>
                <label className="text-sm font-medium mb-1 block">Combo Name</label>
                <div className="flex items-stretch">
                  <span className="inline-flex items-center px-2 rounded-l border border-r-0 border-black/10 dark:border-white/10 bg-black/[0.04] dark:bg-white/[0.04] text-text-muted font-mono text-sm">{forcePrefix}</span>
                  <input value={name} onChange={handleNameChange} placeholder="my-combo"
                    className="flex-1 min-w-0 rounded-r border border-black/10 dark:border-white/10 bg-white dark:bg-black/20 px-2 py-1.5 font-mono text-sm outline-none focus:border-primary" />
                </div>
                {nameError && <p className="text-[11px] text-red-500 mt-0.5">{nameError}</p>}
              </>
            ) : (
              <Input label="Combo Name" value={name} onChange={handleNameChange} placeholder="my-combo" error={nameError} />
            )}
            <p className="text-[10px] text-text-muted mt-0.5">
              {forcePrefix ? `Auto-prefixed with "${forcePrefix}". ` : ""}Only letters, numbers, -, _ and . allowed
            </p>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Models</label>
            {models.length === 0 ? (
              <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                <p className="text-xs text-text-muted">No models added yet</p>
              </div>
            ) : (
              <div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
                {models.map((model, index) => (
                  <ModelItem key={index} index={index} model={model}
                    isFirst={index === 0} isLast={index === models.length - 1}
                    onEdit={(v) => { const a = [...models]; a[index] = v; setModels(a); }}
                    onMoveUp={() => handleMoveUp(index)}
                    onMoveDown={() => handleMoveDown(index)}
                    onRemove={() => handleRemoveModel(index)}
                    timeoutSec={nodeTimeoutSec[model] || ""}
                    onTimeoutChange={(v) => setNodeTimeoutSec((prev) => ({ ...prev, [model]: v }))} />
                ))}
              </div>
            )}
            <button onClick={() => setShowModelSelect(true)}
              className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1">
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Model
            </button>
          </div>

          <div>
            <label htmlFor="combo-reasoning-timeout" className="mb-1 flex items-center gap-1 text-sm font-medium">
              <span className="material-symbols-outlined text-[15px] text-text-muted">timer</span>
              Timeout reasoning
              <span className="text-[10px] font-normal text-text-muted">(giây)</span>
            </label>
            <div className="flex items-stretch">
              <input id="combo-reasoning-timeout" type="number" min="4" max="300" step="1" inputMode="numeric"
                value={reasoningTimeoutSec}
                onChange={(e) => setReasoningTimeoutSec(e.target.value)}
                placeholder="120 (mặc định)"
                className="min-w-0 flex-1 rounded-l border border-r-0 border-black/10 bg-white px-2 py-1.5 text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-black/20" />
              <span className="inline-flex items-center rounded-r border border-black/10 bg-black/[0.04] px-2 font-mono text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.04]">giây</span>
            </div>
            <p className="mt-0.5 text-[10px] text-text-muted">
              Thời gian chờ member <span className="font-medium">reasoning</span> ra nội dung đầu trước khi rơi fallback. Trống = mặc định 120s. Chỉ áp cho model nghĩ lâu (fable/glm/claude…), không đụng fallback nhanh như grok. Giới hạn 4–300s.
            </p>
          </div>

          <div>
            <label htmlFor="combo-vision-model" className="mb-1 flex items-center gap-1 text-sm font-medium">
              <span className="material-symbols-outlined text-[15px] text-text-muted">visibility</span>
              Vision model
              <span className="text-[10px] font-normal text-text-muted">(external)</span>
            </label>
            <input id="combo-vision-model" type="text"
              value={visionModel}
              onChange={(e) => setVisionModel(e.target.value)}
              placeholder="vd: kimi-k2.7-vision  hoặc  ollama/kimi-k2.7-code"
              className="w-full rounded border border-black/10 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-black/20" />
            <p className="mt-0.5 text-[10px] text-text-muted">
              Khi request <span className="font-medium">có ảnh</span>, dùng model/combo này xử lý vision (thử trước các member). Nhập <span className="font-mono">prefix/model</span> hoặc tên combo vision. Trống = dùng vision của member trong combo.
            </p>
          </div>

          <div>
            <label htmlFor="combo-pdf-model" className="mb-1 flex items-center gap-1 text-sm font-medium">
              <span className="material-symbols-outlined text-[15px] text-text-muted">picture_as_pdf</span>
              PDF model
              <span className="text-[10px] font-normal text-text-muted">(external)</span>
            </label>
            <input id="combo-pdf-model" type="text"
              value={pdfModel}
              onChange={(e) => setPdfModel(e.target.value)}
              placeholder="vd: cheat/claude-opus-4-8  hoặc  euro/…/gpt-5.6-terra"
              className="w-full rounded border border-black/10 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-black/20" />
            <p className="mt-0.5 text-[10px] text-text-muted">
              Khi request <span className="font-medium">có PDF/document</span>, dùng model/combo này (thử trước các member). Trống = dùng member combo.
            </p>
          </div>

          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">Cancel</Button>
            <Button onClick={handleSave} fullWidth size="sm" disabled={!name.trim() || !!nameError || saving}>
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      <ModelSelectModal isOpen={showModelSelect} onClose={() => setShowModelSelect(false)}
        onSelect={handleAddModel} onDeselect={handleDeselectModel}
        activeProviders={activeProviders} modelAliases={modelAliases}
        title="Add Model to Combo" kindFilter={kindFilter}
        addedModelValues={models} closeOnSelect={false} />
    </>
  );
}
