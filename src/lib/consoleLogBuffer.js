import { EventEmitter } from "events";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config.js";
// Static import so Next.js standalone build includes errorLogsRepo
import { saveErrorLog } from "@/lib/db/repos/errorLogsRepo.js";

const consoleLevels = ["log", "info", "warn", "error", "debug"];
const DEFAULT_RETENTION_MS = CONSOLE_LOG_CONFIG.defaultRetentionMs;

if (!global._consoleLogBufferState) {
  global._consoleLogBufferState = {
    logs: [],
    patched: false,
    originals: {},
    emitter: new EventEmitter(),
    retentionMs: DEFAULT_RETENTION_MS,
    pruneTimer: null,
  };
  global._consoleLogBufferState.emitter.setMaxListeners(50);
}

const state = global._consoleLogBufferState;

// Ensure emitter exists (handles hot reload with stale global)
if (!state.emitter) {
  state.emitter = new EventEmitter();
  state.emitter.setMaxListeners(50);
}
if (state.retentionMs === undefined) state.retentionMs = DEFAULT_RETENTION_MS;

function normalizeLogEntries() {
  const now = Date.now();
  state.logs = state.logs.map((entry) => typeof entry === "string" ? { line: entry, createdAt: now } : entry);
}

normalizeLogEntries();

function toLogLine(level, args) {
  return args.map(formatArg).join(" ");
}

// Strip ANSI escape codes so terminal colors don't bleed into UI
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, "");
}

function formatArg(arg) {
  if (typeof arg === "string") return stripAnsi(arg);
  if (arg instanceof Error) return stripAnsi(arg.stack || arg.message || String(arg));
  try {
    return stripAnsi(JSON.stringify(arg));
  } catch {
    return stripAnsi(String(arg));
  }
}

function appendLine(line, request = null) {
  pruneExpiredLogs(false);
  const entry = { line, createdAt: Date.now(), ...(request ? { request } : {}) };
  state.logs.push(entry);
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  if (state.logs.length > maxLines) {
    state.logs = state.logs.slice(-maxLines);
  }
  state.emitter.emit("line", entry);
}

function formatRequestLog({ status = 200, stream = false, provider, model, duration = 0, ttft = 0, tokens = {}, displayProvider = null, comboName = null }) {
  const inputTokens = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const outputTokens = tokens.output_tokens ?? tokens.completion_tokens ?? 0;
  const name = displayProvider || (provider || "unknown").slice(0, 25);
  const combo = comboName ? `[${comboName}] ` : "";
  return `[${status}] stream:${Boolean(stream)} ${combo}${name}/${model || "unknown"} | ${Math.max(0, Math.round(duration))}ms (TTFT ${Math.max(0, Math.round(ttft))}) | In: ${inputTokens} | Out: ${outputTokens}`;
}

export function appendRequestConsoleLog(request) {
  appendLine(formatRequestLog(request), request);
}

function getLogLines() {
  return state.logs.map((entry) => typeof entry === "string" ? entry : entry.line);
}

function getLogEntries() {
  const now = Date.now();
  return state.logs.map((entry) => {
    if (typeof entry === "string") return { line: entry, createdAt: now };
    return { line: entry.line, createdAt: entry.createdAt, ...(entry.request ? { request: entry.request } : {}) };
  });
}

function pruneExpiredLogs(emit = true) {
  const retentionMs = Number(state.retentionMs) || 0;
  if (retentionMs <= 0) return 0;

  const cutoff = Date.now() - retentionMs;
  const before = state.logs.length;
  state.logs = state.logs.filter((entry) => {
    return entry.createdAt >= cutoff;
  });

  const removed = before - state.logs.length;
  if (removed > 0 && emit) {
    state.emitter.emit("prune", getLogEntries());
  }
  return removed;
}

function ensurePruneTimer() {
  if (state.pruneTimer) return;
  state.pruneTimer = setInterval(() => pruneExpiredLogs(true), CONSOLE_LOG_CONFIG.pruneIntervalMs);
  if (typeof state.pruneTimer.unref === "function") state.pruneTimer.unref();
}

// Persist error/warn logs to SQLite so they survive container restarts
function persistError(level, line) {
  saveErrorLog({ level, message: line }).catch(() => {});
}

export function initConsoleLogCapture() {
  ensurePruneTimer();
  if (state.patched) return;

  for (const level of consoleLevels) {
    state.originals[level] = console[level];
    console[level] = (...args) => {
      const line = toLogLine(level, args);
      appendLine(line);
      state.originals[level](...args);
      // Persist errors and warnings to database
      if (level === "error" || level === "warn") {
        persistError(level, line);
      }
    };
  }

  state.patched = true;
}

export function getConsoleLogs() {
  pruneExpiredLogs(false);
  return getLogLines();
}

export function getConsoleLogEntries() {
  pruneExpiredLogs(false);
  return getLogEntries();
}

export function clearConsoleLogs() {
  const cutoff = Date.now() - CONSOLE_LOG_CONFIG.clearPreserveMs;
  state.logs = state.logs.filter((entry) => typeof entry !== "string" && entry.createdAt >= cutoff);
  if (state.logs.length > 0) {
    state.emitter.emit("prune", getLogEntries());
  } else {
    state.emitter.emit("clear");
  }
}

export function setConsoleLogRetentionMs(retentionMs) {
  const next = Math.max(0, Number(retentionMs) || 0);
  state.retentionMs = next;
  ensurePruneTimer();
  pruneExpiredLogs(true);
}

export function getConsoleEmitter() {
  return state.emitter;
}
