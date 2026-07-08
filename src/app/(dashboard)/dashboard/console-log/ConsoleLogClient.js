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
