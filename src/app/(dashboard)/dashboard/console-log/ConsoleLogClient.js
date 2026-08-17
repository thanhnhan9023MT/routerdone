"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

const RETENTION_OPTIONS = [
  { value: "900000", label: "15 min" },
  { value: "3600000", label: "1 hour" },
  { value: "21600000", label: "6 hours" },
  { value: "86400000", label: "24 hours" },
  { value: "0", label: "Off" },
];

function getBrowserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

function normalizeLogEntry(entry) {
  if (typeof entry === "string") return { line: entry, createdAt: null, request: null };
  if (!entry || typeof entry !== "object") return { line: String(entry ?? ""), createdAt: null, request: null };
  return {
    line: typeof entry.line === "string" ? entry.line : String(entry.line ?? ""),
    createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : null,
    request: entry.request && typeof entry.request === "object" ? entry.request : null,
  };
}

function formatClock(createdAt, timeZone) {
  if (!createdAt) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone, hour12: false, hourCycle: "h23",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(createdAt));
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return get("hour") + ":" + get("minute") + ":" + get("second");
  } catch { return null; }
}

function formatDisplayLine(entry, timeZone) {
  const n = normalizeLogEntry(entry);
  const c = formatClock(n.createdAt, timeZone);
  return c ? "[" + c + "] " + n.line : n.line;
}

// ── Error Fix Settings panel ──

const ERROR_FIX_DEFAULTS = {
  selfHealCooldownMs: 3000,
  busyCooldownMs: 30000,
  consecutiveErrorsBeforeBan: 3,
  softBanDurationMs: 30000,
  longBanDurationMs: 1800000,
  maxRateLimitCooldownMs: 1800000,
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
        {rtk && <span className="text-amber-400/40 text-[9px] ml-1">&#x1F53B;{rtk}</span>}
      </td>
    </tr>
  );
}

// ── Main ──

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [timeZone] = useState(getBrowserTimeZone);
  const [retentionMs, setRetentionMs] = useState(String(CONSOLE_LOG_CONFIG.defaultRetentionMs));
  const [savingRetention, setSavingRetention] = useState(false);
  const [settings, setSettings] = useState(null);
  const [providerNames, setProviderNames] = useState({});
  const consoleLogRef = useRef(null);
  const errorLogRef = useRef(null);
  const autoScrollConsole = useRef(true);
  const autoScrollError = useRef(true);

  // Fetch settings + provider node names
  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/settings", { cache: "no-store" }).then(r => r.ok ? r.json() : null),
      fetch("/api/provider-nodes", { cache: "no-store" }).then(r => r.ok ? r.json() : null),
      fetch("/api/providers", { cache: "no-store" }).then(r => r.ok ? r.json() : null),
    ]).then(([s, nodesData, providersData]) => {
      if (!alive) return;
      if (s) {
        setSettings(s);
        setRetentionMs(String(s.consoleLogRetentionMs ?? CONSOLE_LOG_CONFIG.defaultRetentionMs));
      }
      // Build provider name map: providerId → readable name
      const nameMap = {};
      // From provider nodes (openai-compatible, anthropic-compatible, custom-embedding)
      if (nodesData?.nodes) {
        for (const node of nodesData.nodes) {
          if (node.id && node.name) nameMap[node.id] = node.name;
        }
      }
      // From provider connections (regular providers have name)
      if (providersData?.connections) {
        for (const conn of providersData.connections) {
          if (conn.provider && conn.name) {
            // Only override if we don't already have a node name
            if (!nameMap[conn.provider]) nameMap[conn.provider] = conn.name;
          }
        }
      }
      setProviderNames(nameMap);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // SSE stream for console logs
  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");
    es.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "init" || msg.type === "sync") {
        setLogs((msg.logs || []).map(normalizeLogEntry).slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        setLogs(cur => [...cur, normalizeLogEntry(msg.entry ?? msg.line)].slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "clear") {
        setLogs([]);
      }
    };
    return () => es.close();
  }, []);

  // Apply provider name mapping to entries
  const resolvedLogs = useMemo(() => {
    if (Object.keys(providerNames).length === 0) return logs;
    return logs.map(entry => {
      const n = normalizeLogEntry(entry);
      if (n.request && n.request.provider && providerNames[n.request.provider] && !n.request.displayProvider) {
        return {
          ...entry,
          request: { ...n.request, displayProvider: providerNames[n.request.provider] },
        };
      }
      return entry;
    });
  }, [logs, providerNames]);

  useEffect(() => {
    if (autoScrollConsole.current && consoleLogRef.current) {
      consoleLogRef.current.scrollTop = consoleLogRef.current.scrollHeight;
    }
    if (autoScrollError.current && errorLogRef.current) {
      errorLogRef.current.scrollTop = errorLogRef.current.scrollHeight;
    }
  }, [resolvedLogs]);

  const handleScrollConsole = () => {
    if (!consoleLogRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = consoleLogRef.current;
    autoScrollConsole.current = (scrollHeight - scrollTop - clientHeight) < 40;
  };

  const handleScrollError = () => {
    if (!errorLogRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = errorLogRef.current;
    autoScrollError.current = (scrollHeight - scrollTop - clientHeight) < 40;
  };

  const allEntries = useMemo(() => resolvedLogs.filter(e => normalizeLogEntry(e).request), [resolvedLogs]);
  const errorEntries = useMemo(() => allEntries.filter(e => Number(e.request?.status) >= 400), [allEntries]);

  const handleClear = async () => {
    try { await fetch("/api/translator/console-logs", { method: "DELETE" }); } catch { /* ignore */ }
  };

  const handleDownload = () => {
    const content = logs.map(e => formatDisplayLine(e, timeZone)).join("\n");
    const blob = new Blob([content ? content + "\n" : ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "routerdone-console-log-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
    document.body.appendChild(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
  };

  const handleRetentionChange = async (e) => {
    const next = e.target.value;
    setRetentionMs(next);
    setSavingRetention(true);
    try {
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consoleLogRetentionMs: Number(next) }) });
    } catch { /* ignore */ }
    finally { setSavingRetention(false); }
  };

  const errorGroups = useMemo(() => {
    const groups = {};
    for (const entry of errorEntries) {
      const r = entry.request;
      const key = (r.status ?? "?") + "|" + (r.model || "?");
      if (!groups[key]) groups[key] = { status: r.status, model: r.model, count: 0 };
      groups[key].count++;
    }
    return Object.values(groups).sort((a, b) => b.count - a.count);
  }, [errorEntries]);

  return (
    <div>
      <Card>
        {/* Top bar: controls */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-text-main">Console Log</span>
            <span className="text-[11px] text-text-muted">
              {allEntries.length} requests / {logs.length} lines
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs font-medium text-text-muted">
              <span>Auto-delete</span>
              <select value={retentionMs} onChange={handleRetentionChange} disabled={savingRetention} className="h-7 rounded-[8px] border border-border bg-surface-2 px-3 text-xs font-semibold text-text-main outline-none disabled:opacity-50">
                {RETENTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <Button size="sm" variant="outline" icon="download" onClick={handleDownload} disabled={logs.length === 0}>Download</Button>
            <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>Clear</Button>
          </div>
        </div>

        {/* Two logs side-by-side */}
        <div className="flex gap-0 border-t border-border">
          {/* Console Log (left) */}
          <div className="flex-1 min-w-0 border-r border-border">
            <div className="px-4 py-1.5 border-b border-border/50 bg-black">
              <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Console Log</span>
              <span className="text-[10px] text-text-muted ml-2 tabular-nums">{allEntries.length} reqs</span>
            </div>
            <div ref={consoleLogRef} onScroll={handleScrollConsole} className="bg-black overflow-auto" style={{ height: "calc(100vh - 400px)" }}>
              {allEntries.length === 0 ? (
                <div className="p-4 text-xs text-text-muted">No logs yet.</div>
              ) : (
                <LogTable entries={allEntries} timeZone={timeZone} compact={false} />
              )}
            </div>
          </div>

          {/* Error Log (right) */}
          <div className="w-[360px] flex-none">
            <div className="px-4 py-1.5 border-b border-border/50 bg-black">
              <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider">Error Log</span>
              <span className="text-[10px] text-text-muted ml-2 tabular-nums">{errorEntries.length} errors</span>
            </div>
            {/* Error badges */}
            {errorGroups.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-border/50 bg-black/50">
                {errorGroups.map((g, i) => {
                  const is5 = g.status >= 500;
                  return (
                    <div key={i} className={"flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold " + (is5 ? "bg-red-500/15 border-red-500/30 text-red-300" : "bg-amber-500/15 border-amber-500/30 text-amber-300")}>
                      <span>{g.status}</span>
                      <span className="tabular-nums">x{g.count}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div ref={errorLogRef} onScroll={handleScrollError} className="bg-black overflow-auto" style={{ height: "calc(100vh - " + (errorGroups.length > 0 ? "440" : "415") + "px)" }}>
              {errorEntries.length === 0 ? (
                <div className="p-4 text-xs text-text-muted">No errors. System healthy.</div>
              ) : (
                <LogTable entries={errorEntries} timeZone={timeZone} compact={true} />
              )}
            </div>
          </div>
        </div>

        {/* Error Fix Settings at the bottom */}
        <ErrorFixSettings settings={settings} onSave={(cfg) => setSettings(prev => ({ ...prev, errorFix: cfg }))} />
      </Card>
    </div>
  );
}
