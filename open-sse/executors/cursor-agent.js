import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { existsSync, mkdtempSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";

/**
 * CursorAgentExecutor — drives the local `cursor-agent` CLI as an upstream.
 *
 * Runs Cursor's officially supported headless mode
 * (`cursor-agent -p --output-format stream-json`) and translates its NDJSON
 * event stream into OpenAI chat.completion.chunk SSE.
 *
 * Two request shapes:
 *  - Plain chat (no tools)  → streams text deltas (+ reasoning) as they arrive.
 *  - Function calling (tools[] present) → EMULATED tool calling: the tool
 *    schemas are injected into the prompt, the model is asked to emit each call
 *    inside `___TOOL_CALL___` sentinel markers, the full reply is buffered,
 *    parsed with a balanced-brace scanner, and re-emitted as OpenAI
 *    `tool_calls` (finish_reason="tool_calls"). The cursor-agent CLI has no
 *    native function-calling API, so this shim provides it.
 *
 * Technique credits (verified against open-source cursor-CLI proxies):
 *  - sentinel marker + balanced-brace parse ....... Azhi-ss/cursorcli2api
 *  - `timestamp_ms` gate for delta dedup .......... code-yeongyu/cursor-proxy
 *  - kill-on-result (CLI doesn't always self-exit)  Azhi-ss/cursorcli2api
 *
 * Safety choices:
 *  - `--mode ask` → read-only Q&A; the agent cannot write files or run shell,
 *    so it emits OUR tool JSON instead of executing tools itself.
 *  - prompt on STDIN (not argv) → no arg-length limits, nothing leaks in `ps`.
 *  - API key via env `CURSOR_API_KEY` (not `--api-key` on argv).
 *  - runs in a throwaway empty temp dir → nothing local for the agent to read.
 *  - binary resolved from a hardcoded candidate list, never user config (RCE).
 *
 * Single-user / self-host only.
 */

const DEFAULT_TIMEOUT_MS = 180_000;
const TOOL_MARKER = "___TOOL_CALL___";

let cachedBinary = null;
function resolveBinary() {
  if (cachedBinary) return cachedBinary;
  const candidates = [
    process.env.CURSOR_AGENT_BIN,
    join(homedir(), ".local/bin/cursor-agent"),
    "/usr/local/bin/cursor-agent",
    "/usr/bin/cursor-agent",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return (cachedBinary = c);
  }
  return (cachedBinary = "cursor-agent");
}

let cachedWorkdir = null;
function resolveWorkdir() {
  if (cachedWorkdir) return cachedWorkdir;
  return (cachedWorkdir = mkdtempSync(join(tmpdir(), "routerdone-cursor-agent-")));
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === "text" || typeof c.text === "string"))
      .map((c) => String(c.text || ""))
      .join(" ");
  }
  return "";
}

// Flatten OpenAI messages into a single prompt for a plain chat request.
function flattenMessages(messages = []) {
  const extracted = [];
  for (const msg of messages) {
    let role = String(msg?.role || "user");
    if (role === "developer") role = "system";
    const content = textFromContent(msg?.content);
    if (!content.trim()) continue;
    extracted.push({ role, text: content });
  }

  let lastUserIdx = -1;
  for (let i = extracted.length - 1; i >= 0; i--) {
    if (extracted[i].role === "user") { lastUserIdx = i; break; }
  }

  const parts = [];
  for (let i = 0; i < extracted.length; i++) {
    const { role, text } = extracted[i];
    parts.push(i === lastUserIdx ? text : `${role}: ${text}`);
  }
  return parts.join("\n\n");
}

// ---- Emulated function calling ---------------------------------------------

function toolName(t) { return t?.function?.name || t?.name || ""; }
function toolDef(t) {
  const fn = t?.function || t;
  return {
    name: fn?.name || "",
    description: fn?.description || "",
    parameters: fn?.parameters || fn?.input_schema || { type: "object", properties: {} },
  };
}

function markerBlock(callObj) {
  return `${TOOL_MARKER}\n${JSON.stringify(callObj)}\n${TOOL_MARKER}`;
}

// Turn the CLI into a JSON function-calling engine, then append the flattened
// conversation (including prior tool calls + results, re-serialized so the
// transcript the model sees stays self-consistent).
function buildToolPrompt(body, tools) {
  const defs = tools.map(toolDef).filter((d) => d.name);
  const toolChoice = body?.tool_choice;
  let mustCall = "";
  if (toolChoice === "required") {
    mustCall = "\n- You MUST call at least one tool this turn.";
  } else if (toolChoice && typeof toolChoice === "object") {
    const forced = toolChoice.function?.name || toolChoice.name;
    if (forced) mustCall = `\n- You MUST call the tool "${forced}" this turn.`;
  }

  const toolList = defs
    .map((d) => `- ${d.name}: ${d.description || "(no description)"}\n  parameters: ${JSON.stringify(d.parameters)}`)
    .join("\n");

  const header =
`You are a function-calling engine that answers the user by either calling tools or replying in plain text. You have access to EXACTLY these tools and no others:

${toolList}

When you need to call a tool, output a block delimited by the exact marker ${TOOL_MARKER} on its own line, containing ONLY a JSON object:

${TOOL_MARKER}
{"name": "<tool_name>", "arguments": { ... }}
${TOOL_MARKER}

Rules:
- Emit one marker block per tool call. For multiple/parallel calls, emit several blocks back to back.
- Argument values must satisfy each tool's JSON-schema parameters. Output raw JSON only inside the markers (no code fences, no comments).
- If a marker block is present, put NOTHING else outside the markers.
- If NO tool is needed, answer the user normally in plain text with no markers.
- Never actually execute anything or use your own tools; only emit the marker block(s) or the plain answer.${mustCall}

--- Conversation ---`;

  const idToName = {};
  const lines = [];
  for (const msg of body?.messages || []) {
    const role = String(msg?.role || "user");
    if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const txt = textFromContent(msg.content);
      if (txt.trim()) lines.push(`assistant: ${txt}`);
      const blocks = msg.tool_calls.map((tc) => {
        const name = tc.function?.name || tc.name || "";
        if (tc.id) idToName[tc.id] = name;
        let args = tc.function?.arguments ?? tc.arguments ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep */ } }
        return markerBlock({ name, arguments: args });
      });
      lines.push(`assistant:\n${blocks.join("\n")}`);
    } else if (role === "tool") {
      const name = idToName[msg.tool_call_id] || msg.name || "tool";
      lines.push(`Tool ${name} result: ${textFromContent(msg.content)}`);
    } else {
      const txt = textFromContent(msg.content);
      if (txt.trim()) lines.push(`${role === "developer" ? "system" : role}: ${txt}`);
    }
  }
  lines.push("\nRespond now (marker tool block(s), or a plain-text answer):");
  return `${header}\n${lines.join("\n")}`;
}

// Parse a model reply into [{name, arguments}] or null (plain text).
function parseToolCalls(text, validNames) {
  if (!text) return null;
  const calls = [];

  if (text.includes(TOOL_MARKER)) {
    // Payloads sit between consecutive markers: split → odd indices are content.
    const parts = text.split(TOOL_MARKER);
    for (let i = 1; i < parts.length; i += 2) {
      const payload = parts[i].trim();
      if (!payload) continue;
      const obj = safeJson(payload) ?? extractFirstJson(payload);
      if (obj) pushNormalized(calls, obj);
    }
  } else {
    // No markers — accept a bare JSON object (fence-stripped) as a fallback.
    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const obj = safeJson(s) ?? extractFirstJson(s);
    if (obj) pushNormalized(calls, obj);
  }

  const filtered = calls.filter((c) => c.name && (!validNames?.size || validNames.has(c.name)));
  return filtered.length ? filtered : null;
}

function pushNormalized(out, obj) {
  let raw = null;
  if (Array.isArray(obj.tool_calls)) raw = obj.tool_calls;
  else if (obj.tool_call && typeof obj.tool_call === "object") raw = [obj.tool_call];
  else if (obj.name && (obj.arguments !== undefined || obj.parameters !== undefined || obj.function)) raw = [obj];
  else if (obj.name) raw = [obj];
  if (!raw) return;
  for (const c of raw) {
    const name = c?.name || c?.function?.name;
    if (!name) continue;
    let args = c?.arguments ?? c?.parameters ?? c?.function?.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
    out.push({ name, arguments: args && typeof args === "object" ? args : {} });
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// Find and parse the first balanced JSON object/array in a string.
function extractFirstJson(s) {
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{" || s[i] === "[") { start = i; break; }
  }
  if (start < 0) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      if (--depth === 0) return safeJson(s.slice(start, i + 1));
    }
  }
  return null;
}

// ---- shared helpers --------------------------------------------------------

function sseChunk(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

function mapErrorStatus(stderr) {
  const s = (stderr || "").toLowerCase();
  if (s.includes("cannot use this model") || s.includes("available models") || s.includes("unknown model")) return 400;
  if (s.includes("api key") || s.includes("invalid") || s.includes("unauthor") || s.includes("authenticate")) return 401;
  if (s.includes("rate limit") || s.includes("too many") || s.includes("quota")) return 429;
  if (s.includes("enoent") || s.includes("no such file")) return 500;
  return 502;
}

function jsonError(status, message, code) {
  return new Response(
    JSON.stringify({ error: { message, type: "upstream_error", code: code || "CURSOR_AGENT_ERROR" } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

async function* readNdjson(stdout) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* ignore non-JSON */ }
    }
  }
  const tail = buffer.trim();
  if (tail) { try { yield JSON.parse(tail); } catch { /* ignore */ } }
}

function assistantText(event) {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && c.type === "text").map((c) => String(c.text || "")).join("");
}

// Exported for unit tests.
export { parseToolCalls, buildToolPrompt, extractFirstJson, flattenMessages };

export class CursorAgentExecutor extends BaseExecutor {
  constructor() {
    super("cursor-agent", PROVIDERS["cursor-agent"]);
  }

  async execute({ model, body, credentials, signal, log }) {
    const apiKey = credentials?.apiKey || credentials?.accessToken;
    if (!apiKey || apiKey === "public") {
      return this._err(body, jsonError(401, "Cursor API key is required (crsr_...). Add it to this connection.", "MISSING_KEY"));
    }

    const tools = Array.isArray(body?.tools) ? body.tools.filter((t) => toolName(t)) : [];
    const toolMode = tools.length > 0 && body?.tool_choice !== "none";
    const prompt = toolMode ? buildToolPrompt(body, tools) : flattenMessages(body?.messages);
    if (!prompt.trim()) {
      return this._err(body, jsonError(400, "Empty prompt after processing messages.", "EMPTY_PROMPT"));
    }

    const binary = resolveBinary();
    const workdir = resolveWorkdir();
    const timeoutMs = this.config?.timeoutMs || DEFAULT_TIMEOUT_MS;

    // Tool mode buffers the whole reply (need complete JSON), so partial-output
    // streaming would only add overhead; plain chat streams token deltas.
    const args = ["-p", "--output-format", "stream-json", "--mode", "ask", "--trust"];
    if (!toolMode) args.push("--stream-partial-output");
    if (model && model !== "auto" && model !== "default") args.push("--model", model);

    let child;
    try {
      child = spawn(binary, args, {
        cwd: workdir,
        env: { ...process.env, CURSOR_API_KEY: apiKey },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return this._err(body, jsonError(500, `Failed to launch cursor-agent: ${err?.message || String(err)}`, "SPAWN_FAILED"));
    }

    let stderr = "";
    child.stderr.on("data", (d) => { if (stderr.length < 8192) stderr += d.toString(); });

    let exitCode = null, exitErr = null;
    const exited = new Promise((resolve) => {
      child.on("close", (code) => { exitCode = code; resolve(); });
      child.on("error", (err) => { exitErr = err; resolve(); });
    });

    // cursor-agent does not always exit after emitting `result`; kill hard so
    // `exited` resolves promptly instead of waiting for the wall-clock timeout.
    const killChild = (sig = "SIGTERM") => { try { child.kill(sig); } catch { /* ignore */ } };
    const timer = setTimeout(() => killChild("SIGKILL"), timeoutMs);
    const onAbort = () => killChild("SIGKILL");
    if (signal) {
      if (signal.aborted) killChild("SIGKILL");
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener?.("abort", onAbort); };

    try { child.stdin.write(prompt); child.stdin.end(); } catch { /* surfaces below */ }

    const events = readNdjson(child.stdout);

    // Wait until the session confirms it started; otherwise it's an auth/launch failure.
    let started = false;
    const buffered = [];
    while (true) {
      const next = await events.next();
      if (next.done) break;
      const ev = next.value;
      buffered.push(ev);
      if (ev.type === "system" || ev.type === "assistant" || ev.type === "thinking" || ev.type === "result") {
        started = true;
        break;
      }
    }

    if (!started) {
      await exited;
      cleanup();
      const status = mapErrorStatus(stderr);
      const msg = exitErr
        ? `cursor-agent failed to start: ${exitErr.message}`
        : (stderr.trim() || `cursor-agent exited with code ${exitCode} before producing output`);
      log?.(`[cursor-agent] start failure (status ${status}): ${msg}`);
      return this._err({ model, prompt }, jsonError(status, msg, "CLI_START_FAILED"));
    }

    const cid = "chatcmpl-cursor-agent-" + randomUUID().slice(0, 12);
    const created = Math.floor(Date.now() / 1000);
    const outModel = model || "cursor-agent";
    const getExit = () => exitCode;
    const getStderr = () => stderr;

    if (toolMode) {
      const validNames = new Set(tools.map(toolName));
      const full = await this._collectText(buffered, events, exited, killChild);
      const stream = this._toolStream(full, validNames, cid, created, outModel, getExit, getStderr, cleanup, killChild);
      return this._resp(stream, { model: outModel, prompt, mode: "tool" });
    }

    const stream = this._textStream(buffered, events, exited, cid, created, outModel, getExit, getStderr, cleanup, killChild);
    return this._resp(stream, { model: outModel, prompt, mode: "chat" });
  }

  // Drain every event into { text, hadError, errorMessage }; stop at `result`.
  async _collectText(buffered, events, exited, killChild) {
    let deltaText = "", fallbackText = "", resultText = "";
    let hadError = false, errorMessage = "";
    const handle = (ev) => {
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "assistant") {
        const t = assistantText(ev);
        if (!t) return;
        if (ev.timestamp_ms != null) deltaText += t;
        else fallbackText = t;
      } else if (ev.type === "result") {
        if (ev.is_error) { hadError = true; errorMessage = ev.result || ev.error || "cursor-agent error"; }
        else if (typeof ev.result === "string") resultText = ev.result;
      }
    };
    for (const ev of buffered) if (ev?.type === "result") { handle(ev); killChild("SIGKILL"); }
    for (const ev of buffered) if (ev?.type !== "result") handle(ev);
    let sawResult = buffered.some((e) => e?.type === "result");
    if (!sawResult) {
      for await (const ev of events) {
        handle(ev);
        if (ev?.type === "result") { killChild("SIGKILL"); break; }
      }
    }
    await exited;
    return { text: deltaText || fallbackText || resultText, hadError, errorMessage };
  }

  // Emit an OpenAI tool_calls response (or plain content when no call parsed).
  _toolStream(full, validNames, cid, created, outModel, getExit, getStderr, cleanup, killChild) {
    const calls = full.hadError ? null : parseToolCalls(full.text, validNames);
    return new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const base = { id: cid, object: "chat.completion.chunk", created, model: outModel };
        const emit = (delta, finish) =>
          controller.enqueue(enc.encode(sseChunk({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null, logprobs: null }] })));
        try {
          emit({ role: "assistant" });
          if (full.hadError) {
            emit({ content: `[cursor-agent error: ${full.errorMessage}]` });
            emit({}, "stop");
          } else if (calls) {
            const tool_calls = calls.map((c, i) => ({
              index: i,
              id: "call_" + randomUUID().replace(/-/g, "").slice(0, 24),
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            }));
            emit({ tool_calls });
            emit({}, "tool_calls");
          } else {
            if (full.text) emit({ content: full.text });
            else { const code = getExit(); if (code && code !== 0) emit({ content: `[cursor-agent exited with code ${code}${getStderr().trim() ? `: ${getStderr().trim()}` : ""}]` }); }
            emit({}, "stop");
          }
          controller.enqueue(enc.encode(SSE_DONE));
        } finally {
          cleanup(); killChild("SIGKILL"); controller.close();
        }
      },
      cancel() { cleanup(); killChild("SIGKILL"); },
    });
  }

  // Stream plain-chat text deltas (+ reasoning) as they arrive.
  _textStream(buffered, events, exited, cid, created, outModel, getExit, getStderr, cleanup, killChild) {
    return new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const base = { id: cid, object: "chat.completion.chunk", created, model: outModel };
        const emit = (delta, finish) =>
          controller.enqueue(enc.encode(sseChunk({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null, logprobs: null }] })));
        try {
          emit({ role: "assistant" });
          let deltaEmitted = false, fallbackText = "", resultText = "", hadError = false, errorMessage = "";
          const handle = (ev) => {
            if (!ev || typeof ev !== "object") return;
            if (ev.type === "thinking") {
              if (ev.subtype === "delta" && ev.text) emit({ reasoning_content: ev.text });
            } else if (ev.type === "assistant") {
              const t = assistantText(ev);
              if (!t) return;
              if (ev.timestamp_ms != null) { emit({ content: t }); deltaEmitted = true; }
              else fallbackText = t;
            } else if (ev.type === "result") {
              if (ev.is_error) { hadError = true; errorMessage = ev.result || ev.error || "cursor-agent error"; }
              else if (typeof ev.result === "string") resultText = ev.result;
            }
          };
          for (const ev of buffered) handle(ev);
          const sawResult = buffered.some((e) => e?.type === "result");
          if (!sawResult) {
            for await (const ev of events) {
              handle(ev);
              if (ev?.type === "result") { killChild("SIGKILL"); break; }
            }
          }
          await exited;

          if (hadError) emit({ content: `\n[cursor-agent error: ${errorMessage}]` });
          else if (!deltaEmitted) {
            const full = fallbackText || resultText;
            if (full) emit({ content: full });
            else { const code = getExit(); if (code && code !== 0) emit({ content: `\n[cursor-agent exited with code ${code}${getStderr().trim() ? `: ${getStderr().trim()}` : ""}]` }); }
          }
          emit({}, "stop");
          controller.enqueue(enc.encode(SSE_DONE));
        } catch (err) {
          emit({ content: `\n[stream error: ${err?.message || String(err)}]` }, "stop");
          controller.enqueue(new TextEncoder().encode(SSE_DONE));
        } finally {
          cleanup(); killChild("SIGKILL"); controller.close();
        }
      },
      cancel() { cleanup(); killChild("SIGKILL"); },
    });
  }

  _resp(stream, transformedBody) {
    return { response: new Response(stream, { status: 200, headers: SSE_HEADERS_NO_BUFFER }), url: "cursor-agent://local", headers: {}, transformedBody };
  }
  _err(transformedBody, response) {
    return { response, url: "cursor-agent://local", headers: {}, transformedBody };
  }
}

export default CursorAgentExecutor;
