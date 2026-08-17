// Logger utility for cloud
//
// Log level resolution (highest priority first):
//   1. LOG_LEVEL env (DEBUG|INFO|WARN|ERROR)
//   2. NODE_ENV=production -> WARN (only warn+error; cuts verbose per-request
//      AUTH/ROUTING/FORMAT/MODALITY/CTX-GUARD/HEADROOM/CAVEMAN noise that was
//      spiking CPU on loaded deploys via consoleLogBuffer + stdout I/O)
//   3. otherwise (dev) -> DEBUG (full verbose output for local debugging)
//
// Override to DEBUG at runtime with LOG_LEVEL=DEBUG when you need verbose
// diagnostics on a production deploy.

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

function resolveLevel() {
  const env = (typeof process !== "undefined" && process.env?.LOG_LEVEL || "").toUpperCase();
  if (env in LOG_LEVELS) return LOG_LEVELS[env];
  // Production ships quiet by default to avoid CPU/IO pressure under load.
  // Dev keeps verbose output for local debugging.
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") return LOG_LEVELS.WARN;
  return LOG_LEVELS.DEBUG;
}

const LEVEL = resolveLevel();

function formatTime() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function formatData(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function debug(tag, message, data) {
  if (LEVEL <= LOG_LEVELS.DEBUG) {
    const dataStr = data ? ` ${formatData(data)}` : "";
    console.log(`[${formatTime()}] 🔍 [${tag}] ${message}${dataStr}`);
  }
}

export function info(tag, message, data) {
  if (LEVEL <= LOG_LEVELS.INFO) {
    const dataStr = data ? ` ${formatData(data)}` : "";
    console.log(`[${formatTime()}] ℹ️  [${tag}] ${message}${dataStr}`);
  }
}

export function warn(tag, message, data) {
  if (LEVEL <= LOG_LEVELS.WARN) {
    const dataStr = data ? ` ${formatData(data)}` : "";
    // console.warn(`[${formatTime()}] ⚠️  [${tag}] ${message}${dataStr}`);
  }
}

export function error(tag, message, data) {
  if (LEVEL <= LOG_LEVELS.ERROR) {
    const dataStr = data ? ` ${formatData(data)}` : "";
    console.log(`[${formatTime()}] ❌ [${tag}] ${message}${dataStr}`);
  }
}

export function request(method, path, extra) {
  const dataStr = extra ? ` ${formatData(extra)}` : "";
  console.log(`\x1b[36m[${formatTime()}] 📥 ${method} ${path}${dataStr}\x1b[0m`);
}

export function response(status, duration, extra) {
  const icon = status < 400 ? "📤" : "💥";
  const dataStr = extra ? ` ${formatData(extra)}` : "";
  console.log(`[${formatTime()}] ${icon} ${status} (${duration}ms)${dataStr}`);
}

export function stream(event, data) {
  const dataStr = data ? ` ${formatData(data)}` : "";
  console.log(`[${formatTime()}] 🌊 [STREAM] ${event}${dataStr}`);
}

// Mask sensitive data
export function maskKey(key) {
  if (!key || key.length < 8) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// Expose resolved level for callers that build their own log lines (e.g.
// chatCore direct console.log guards) so they can honour the same gate.
export const CURRENT_LOG_LEVEL = LEVEL;
export { LOG_LEVELS };

