import { statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const encoder = new TextEncoder();
  const state = {
    closed: false,
    controller: null,
    keepalive: null,
    debounceTimer: null,
    refreshInFlight: false,
    refreshPending: false,
    onEvent: null,
    onAbort: null,
  };

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.keepalive) clearInterval(state.keepalive);
    if (state.onEvent) {
      statsEmitter.off("update", state.onEvent);
      statsEmitter.off("pending", state.onEvent);
    }
    if (state.onAbort) request.signal.removeEventListener("abort", state.onAbort);
    try { state.controller?.close(); } catch {}
  };

  const safeEnqueue = (chunk) => {
    if (state.closed || !state.controller) return false;
    try {
      state.controller.enqueue(encoder.encode(chunk));
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      state.controller = controller;
      state.onAbort = cleanup;
      request.signal.addEventListener("abort", state.onAbort, { once: true });

      const runRefresh = async () => {
        if (state.closed || state.refreshInFlight) return;
        state.refreshInFlight = true;
        state.refreshPending = false;
        try {
          const live = await getActiveRequests();
          safeEnqueue(`data: ${JSON.stringify(live)}\n\n`);
        } catch {
          cleanup();
        } finally {
          state.refreshInFlight = false;
          if (!state.closed && state.refreshPending) scheduleRefresh();
        }
      };

      const scheduleRefresh = () => {
        if (state.closed) return;
        state.refreshPending = true;
        if (state.refreshInFlight || state.debounceTimer) return;
        state.debounceTimer = setTimeout(() => {
          state.debounceTimer = null;
          void runRefresh();
        }, 100);
      };

      state.onEvent = scheduleRefresh;
      statsEmitter.on("update", state.onEvent);
      statsEmitter.on("pending", state.onEvent);
      state.keepalive = setInterval(() => {
        if (!safeEnqueue(": ping\n\n")) cleanup();
      }, 25000);
      state.keepalive.unref?.();
      void runRefresh();
    },
    cancel: cleanup,
  });

  if (request.signal.aborted) cleanup();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}