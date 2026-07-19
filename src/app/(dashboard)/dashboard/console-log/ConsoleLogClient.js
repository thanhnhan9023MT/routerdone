"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

const RETENTION_OPTIONS = [
  { value: "900000", label: "15 min" },
  { value: "3600000", label: "1 hour" },
  { value: "21600000", label: "6 hours" },
  { value: "86400000", label: "24 hours" },
  { value: "0", label: "Off" },
];

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

function colorLine(line) {
  const match = line.match(/\[(\w+)\]/g);
  const levelTag = match ? match[1]?.replace(/\[|\]/g, "") : null;
  const color = LOG_LEVEL_COLORS[levelTag] || "text-green-400";
  return <span className={color}>{line}</span>;
}

function getBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function normalizeLogEntry(entry) {
  if (typeof entry === "string") return { line: entry, createdAt: null };
  if (!entry || typeof entry !== "object") return { line: String(entry ?? ""), createdAt: null };
  return {
    line: typeof entry.line === "string" ? entry.line : String(entry.line ?? ""),
    createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : null,
  };
}

function formatClock(createdAt, timeZone) {
  if (!createdAt) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour12: false,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(createdAt));
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get("hour")}:${get("minute")}:${get("second")}`;
  } catch {
    return null;
  }
}

function formatDisplayLine(entry, timeZone) {
  const normalized = normalizeLogEntry(entry);
  const localClock = formatClock(normalized.createdAt, timeZone);
  if (!localClock) return normalized.line;
  return normalized.line.replace(/^\[\d{2}:\d{2}:\d{2}\]/, `[${localClock}]`);
}

const handleDownload = (logs, timeZone) => {
  const content = logs.map((line) => formatDisplayLine(line, timeZone)).join("\n");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const blob = new Blob([content ? `${content}\n` : ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `routerdone-console-log-${timestamp}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};



function ErrorFixSettings({ settings, onSave }) {
  const [cfg, setCfg] = useState(() => ({ ...ERROR_FIX_DEFAULTS, ...(settings?.errorFix || {}) }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = (key, val) => setCfg(prev => ({ ...prev, [key]: Number(val) || 0 }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ errorFix: cfg }),
      });
      if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); if (onSave) onSave(cfg); }
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const row = (label, key, unit = "ms") => (
    <div key={key} className="flex items-center gap-2 py-1.5">
      <span className="text-[11px] text-text-muted w-44 flex-none">{label}</span>
      <input
        type="number"
        min={0}
        value={cfg[key]}
        onChange={e => set(key, e.target.value)}
        className="w-24 h-7 rounded border border-border bg-surface-2 px-2 text-[11px] text-text-main outline-none"
      />
      <span className="text-[10px] text-text-muted">{unit}</span>
    </div>
  );

  return (
    <div className="border-t border-border mt-4 px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-text-main">Error Fix Settings</h3>
        <Button size="sm" variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : saved ? "✓ Saved" : "Save"}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-0">
        <div>
          <div className="text-[10px] font-bold text-text-muted uppercase mb-1">Cooldown Durations</div>
          {row("Self-Heal Cooldown", "selfHealCooldownMs")}
          {row("Busy Connection Cooldown", "busyCooldownMs")}
          {row("Max Rate Limit Cooldown", "maxRateLimitCooldownMs")}
        </div>
        <div>
          <div className="text-[10px] font-bold text-text-muted uppercase mb-1">Ban Thresholds</div>
          {row("Consecutive Errors → Ban", "consecutiveErrorsBeforeBan", "errors")}
          {row("Soft Ban Duration", "softBanDurationMs")}
          {row("Long Ban Duration", "longBanDurationMs")}
        </div>
      </div>
    </div>
  );
}

// ── Log Table ──

const COLUMNS = [
  { key: "time", label: "Time", w: "w-[72px]" },
  { key: "status", label: "Status", w: "w-[52px]" },
  { key: "stream", label: "", w: "w-[28px]" },
  { key: "combo", label: "Combo", w: "w-[64px]" },
  { key: "provider", label: "Provider", w: "w-[88px]" },
  { key: "model", label: "Model", w: "w-[120px]" },
  { key: "duration", label: "Duration", w: "w-[85px]" },
  { key: "tokens", label: "Tokens", w: "w-[100px]" },
];

function LogTable({ entries, timeZone, compact }) {
  const cols = compact
    ? COLUMNS.filter(c => c.key !== "stream" && c.key !== "combo")
    : COLUMNS;
  return (
    <table className="w-full text-[11px] font-mono">
      <thead>
        <tr className="border-b border-border/50 text-text-muted sticky top-0 bg-black z-10">
          {cols.map(c => (
            <th key={c.key} className={"text-left font-semibold px-2 py-2 " + c.w}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, i) => <LogRow key={i} entry={entry} timeZone={timeZone} compact={compact} />)}
      </tbody>
    </table>
  );
}

function LogRow({ entry, timeZone, compact }) {
  const { request } = normalizeLogEntry(entry);
  if (!request) {
    const line = formatDisplayLine(entry, timeZone);
    const isErr = /\[(ERROR|FAILED)\]/.test(line);
    const isWarn = /\[WARN/.test(line);
    const colSpan = compact ? 6 : 8;
    return (
      <tr className={"border-b border-white/[0.02] " + (isErr ? "bg-red-500/10" : isWarn ? "bg-amber-500/5" : "")}>
        <td colSpan={colSpan} className={"px-2 py-1 " + (isErr ? "text-red-400" : isWarn ? "text-amber-400" : "text-green-400")}>{line}</td>
      </tr>
    );
  }

  const clock = formatClock(entry.createdAt, timeZone) || "--:--:--";
  const status = request.status ?? 200; const statusLabel = status === 200 ? "OK" : status === 429 ? "RATE" : status === 403 ? "AUTH" : status === 401 ? "AUTH" : status === 402 ? "BILL" : status >= 500 ? "SRV" : status >= 400 ? "ERR" : String(status);
  const isErr = status >= 400;
  const is5xx = status >= 500;
  const tokens = request.tokens || {};
  const input = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const output = tokens.output_tokens ?? tokens.completion_tokens ?? 0;
  const cacheRead = tokens.cache_read_input_tokens ?? tokens.cached_tokens ?? 0;
  const reasoning = tokens.reasoning_tokens ?? 0;
  const cacheCreate = tokens.cache_creation_input_tokens ?? 0;
  const rtk = request.rtkSavings ?? null;
  const provider = request.displayProvider || request.provider || "?";
  const model = request.model || "?";
  const combo = request.comboName;
  const duration = Math.round(request.duration || 0);

  const statusBadge = is5xx
    ? "bg-red-600/30 text-red-200"
    : isErr
      ? "bg-amber-600/30 text-amber-200"
      : "bg-emerald-600/30 text-emerald-200";

  return (
    <tr className={"border-b border-white/[0.02] hover:bg-white/[0.03] " + (isErr ? "bg-red-500/5" : "")}>
      <td className="px-2 py-1.5 text-text-muted tabular-nums">{clock}</td>
      <td className="px-2 py-1.5">
        <span className={"inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums " + statusBadge}>{statusLabel}</span>
      </td>
      {!compact && (
        <td className="px-2 py-1.5">
          <span className={Number(request.stream) ? "text-cyan-400" : "text-amber-400"}>
            {Number(request.stream) ? "S" : "J"}
          </span>
        </td>
      )}
      {!compact && <td className="px-2 py-1.5 text-indigo-300 font-semibold text-[10px]">{combo || "-"}</td>}
      <td className="px-2 py-1.5 text-sky-200 font-semibold">{provider}</td>
      <td className="px-2 py-1.5 text-blue-200 truncate max-w-[120px]" title={model}>{model.slice(0, 22)}</td>
      <td className="px-2 py-1.5 text-amber-300 tabular-nums">{duration}ms{request.ttft > 0 ? <span className="text-text-muted ml-1">T{Math.round(request.ttft)}</span> : null}</td>
      <td className="px-2 py-1.5">
        <span className="text-emerald-300 tabular-nums">{input}</span>
        {cacheRead > 0 && <span className="text-emerald-500/50 tabular-nums text-[9px] ml-0.5">+{cacheRead}c</span>}
        <span className="text-text-muted">/</span>
        <span className="text-sky-300 tabular-nums">{output}</span>
        {reasoning > 0 && <span className="text-purple-400/50 tabular-nums text-[9px] ml-0.5">+{reasoning}t</span>}
        {cacheCreate > 0 && <span className="text-amber-400/50 tabular-nums text-[9px] ml-0.5">w{cacheCreate}</span>}
        {rtk && <span className="text-amber-400/40 text-[9px] ml-1">🔻{rtk}</span>}
      </td>
    </tr>
  );
}

// ── Main ──

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [timeZone] = useState(getBrowserTimeZone);
  const [connected, setConnected] = useState(false);
  const [retentionMs, setRetentionMs] = useState(String(CONSOLE_LOG_CONFIG.defaultRetentionMs));
  const [savingRetention, setSavingRetention] = useState(false);
  const logRef = useRef(null);

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI syncs via SSE after keeping the last 5 minutes.
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  const handleRetentionChange = async (event) => {
    const next = event.target.value;
    setRetentionMs(next);
    setSavingRetention(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consoleLogRetentionMs: Number(next) }),
      });
      if (!res.ok) throw new Error("Failed to update retention");
    } catch (err) {
      console.error("Failed to update console log retention:", err);
    } finally {
      setSavingRetention(false);
    }
  };

  useEffect(() => {
    let alive = true;
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => res.ok ? res.json() : null)
      .then((settings) => {
        if (!alive || !settings) return;
        setRetentionMs(String(settings.consoleLogRetentionMs ?? CONSOLE_LOG_CONFIG.defaultRetentionMs));
      })
      .catch((err) => console.error("Failed to load console log settings:", err));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "init") {
        setLogs((msg.logs || []).map(normalizeLogEntry).slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        setLogs((prev) => {
          const next = [...prev, normalizeLogEntry(msg.entry ?? msg.line)];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "clear") {
        setLogs([]);
      } else if (msg.type === "sync") {
        setLogs((msg.logs || []).map(normalizeLogEntry).slice(-CONSOLE_LOG_CONFIG.maxLines));
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  return (
    <div className="">
      <Card>
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 pt-3 pb-2">
          <label className="flex items-center gap-2 text-xs font-medium text-text-muted">
            <span className="whitespace-nowrap">Auto-delete</span>
            <span className="relative inline-flex items-center">
              <select
                value={retentionMs}
                onChange={handleRetentionChange}
                disabled={savingRetention}
                className="h-7 w-32 appearance-none rounded-[8px] border border-border bg-surface-2 py-1 pl-3 pr-8 text-xs font-semibold text-text-main outline-none transition-all focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20 disabled:opacity-50"
              >
                {RETENTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="material-symbols-outlined pointer-events-none absolute right-2 text-[18px] text-text-muted">expand_more</span>
            </span>
          </label>
          <Button size="sm" variant="outline" icon="download" onClick={() => handleDownload(logs, timeZone)} disabled={logs.length === 0}>
            Download
          </Button>
          <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
            Clear old
          </Button>
        </div>
        <div
          ref={logRef}
          className="bg-black rounded-b-lg p-4 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
        >
          {logs.length === 0 ? (
            <span className="text-text-muted">No console logs yet.</span>
          ) : (
            <div className="space-y-0.5">
              {logs.map((line, i) => (
                <div key={i}>{colorLine(formatDisplayLine(line, timeZone))}</div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
