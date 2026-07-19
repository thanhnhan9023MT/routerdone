import { getConsoleLogEntries, getConsoleEmitter, initConsoleLogCapture, setConsoleLogRetentionMs } from "@/lib/consoleLogBuffer";
import { getSettings } from "@/lib/localDb";
// Static import so Next.js standalone build includes errorLogsRepo module
import { getErrorLogs } from "@/lib/db/repos/errorLogsRepo.js";

export const dynamic = "force-dynamic";

initConsoleLogCapture();

export async function GET(request) {
  const settings = await getSettings();
  setConsoleLogRetentionMs(settings.consoleLogRetentionMs);

  const encoder = new TextEncoder();
  const emitter = getConsoleEmitter();
  const state = { closed: false, send: null, sendClear: null, sendPrune: null, keepalive: null };

  // Idempotent: safe to call from request.signal abort, cancel(), or enqueue failure.
  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) emitter.off("line", state.send);
    if (state.sendClear) emitter.off("clear", state.sendClear);
    if (state.sendPrune) emitter.off("prune", state.sendPrune);
    if (state.keepalive) clearInterval(state.keepalive);
  };

  // request.signal fires reliably on client disconnect; ReadableStream.cancel()
  // is not always invoked in Next.js, which caused listeners to accumulate.
  request.signal.addEventListener("abort", cleanup, { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      // Get buffered in-memory logs
      const buffered = getConsoleLogEntries();

      // Load persistent error logs from DB (survives restarts)
      let dbErrors = [];
      try {
        const persistedErrors = await getErrorLogs({ limit: 500 });
        // Convert DB errors to log entry format, filtering out ones already in the buffer
        const bufferedLines = new Set(buffered.map(e => e.line));
        dbErrors = persistedErrors
          .filter(e => !bufferedLines.has(e.message))
          .map(e => ({
            line: "[" + e.level.toUpperCase() + "] " + (e.source ? "[" + e.source + "] " : "") + e.message,
            createdAt: new Date(e.timestamp).getTime(),
          }));
      } catch (dbErr) {
        // Silently skip — DB may not have the table yet on first boot
      }

      // Merge: DB errors first (historical), then current buffer
      const allLogs = [...dbErrors, ...buffered];
      if (allLogs.length > 0) {
        controller.enqueue(encoder.encode("data: " + JSON.stringify({ type: "init", logs: allLogs }) + "\n\n"));
      }

      // Push new lines as they arrive
      state.send = (entry) => {
        if (state.closed) return;
        const payload = typeof entry === "string" ? { line: entry, createdAt: Date.now() } : entry;
        try {
          controller.enqueue(encoder.encode("data: " + JSON.stringify({ type: "line", entry: payload, line: payload.line }) + "\n\n"));
        } catch {
          cleanup();
        }
      };

      // Notify client when cleared
      state.sendClear = () => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode("data: " + JSON.stringify({ type: "clear" }) + "\n\n"));
        } catch {
          cleanup();
        }
      };

      state.sendPrune = (logs) => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode("data: " + JSON.stringify({ type: "sync", logs }) + "\n\n"));
        } catch {
          cleanup();
        }
      };

      emitter.on("line", state.send);
      emitter.on("clear", state.sendClear);
      emitter.on("prune", state.sendPrune);

      // Keepalive ping every 25s
      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
