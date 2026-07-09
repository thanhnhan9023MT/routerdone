import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

function textFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.output_text === "string") return part.output_text;
  if (Array.isArray(part.content)) return part.content.map(textFromContentPart).filter(Boolean).join("");
  return "";
}

function normalizeAssistantContent(value) {
  if (Array.isArray(value)) return value.map(textFromContentPart).filter(Boolean).join("");
  if (value && typeof value === "object") return textFromContentPart(value);
  return value;
}

function normalizeOpenAIChunkTextFields(parsed) {
  let changed = false;
  if (!Array.isArray(parsed?.choices)) return changed;
  for (const choice of parsed.choices) {
    const delta = choice?.delta;
    if (delta && Array.isArray(delta.content)) {
      delta.content = normalizeAssistantContent(delta.content);
      changed = true;
    }
    const message = choice?.message;
    if (message && Array.isArray(message.content)) {
      message.content = normalizeAssistantContent(message.content);
      changed = true;
    }
  }
  return changed;
}

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null
  } = options;

  let buffer = "";
  let usage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE ? { ...initState(sourceFormat), provider, toolNameMap, model } : null;

  let accumulatedOutputText = "";
  let accumulatedContent = "";
  let accumulatedThinking = "";
  const appendOutputText = (value) => {
    if (typeof value === "string" && value.length > 0) accumulatedOutputText += value;
  };
  const hasAccumulatedOutputText = () => accumulatedOutputText.length > 0;
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Claude passthrough stream repair: track whether terminal events were received
  const isClaudePassthrough = mode === STREAM_MODE.PASSTHROUGH && sourceFormat === FORMATS.CLAUDE;
  let claudeLastBlockIndex = -1;
  let claudeLastBlockStopped = true;
  let claudeMessageDeltaSeen = false;
  let claudeMessageStopSeen = false;
  let claudeStopReason = null;
  let claudeMessageId = null;
  let claudeModel = null;
  let claudeUsage = null;

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());

              const idFixed = fixInvalidId(parsed);

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              if (normalizeOpenAIChunkTextFields(parsed)) {
                fieldsInjected = true;
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              if (!hasValuableContent(parsed, isClaudePassthrough ? FORMATS.CLAUDE : FORMATS.OPENAI)) {
                continue;
              }

              // Claude passthrough: track terminal event state
              if (isClaudePassthrough) {
                const evtType = parsed.type;
                if (evtType === "message_start") {
                  claudeMessageId = parsed.message?.id || null;
                  claudeModel = parsed.message?.model || null;
                } else if (evtType === "content_block_start") {
                  claudeLastBlockIndex = parsed.index ?? claudeLastBlockIndex + 1;
                  claudeLastBlockStopped = false;
                  if (parsed.content_block?.type === "tool_use") {
                    claudeStopReason = "tool_use";
                  }
                } else if (evtType === "content_block_stop") {
                  claudeLastBlockStopped = true;
                } else if (evtType === "message_delta") {
                  claudeMessageDeltaSeen = true;
                  if (parsed.delta?.stop_reason) claudeStopReason = parsed.delta.stop_reason;
                  if (parsed.usage) claudeUsage = parsed.usage;
                } else if (evtType === "message_stop") {
                  claudeMessageStopSeen = true;
                }

                // Accumulate Claude content for usage estimation fallback
                const claudeDelta = parsed.delta;
                if (claudeDelta?.text && typeof claudeDelta.text === "string") {
                  appendOutputText(claudeDelta.text);
                  accumulatedContent += claudeDelta.text;
                }
                if (claudeDelta?.thinking && typeof claudeDelta.thinking === "string") {
                  appendOutputText(claudeDelta.thinking);
                  accumulatedThinking += claudeDelta.thinking;
                }
                if (claudeDelta?.partial_json && typeof claudeDelta.partial_json === "string") {
                  appendOutputText(claudeDelta.partial_json);
                }
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (content && typeof content === "string") {
                appendOutputText(content);
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                appendOutputText(reasoning);
                accumulatedThinking += reasoning;
              }

              // OpenAI Responses passthrough: delta is a string on response.*.delta
              // events. Accumulate actual text so the usage
              // fallback can fire when upstream omits usage (e.g. dynamic
              // openai-compatible-responses connections), so Recent Requests + the
              // per-model table get a row with the real model name.
              if (typeof parsed.delta === "string" && parsed.delta) {
                if (parsed.type === "response.output_text.delta") {
                  appendOutputText(parsed.delta);
                  accumulatedContent += parsed.delta;
                } else if (parsed.type === "response.reasoning_summary_text.delta" || parsed.type === "response.reasoning_text.delta") {
                  appendOutputText(parsed.delta);
                  accumulatedThinking += parsed.delta;
                }
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = extracted;
              }

              // Reasoning models (grok/xAI) report reasoning_tokens ON TOP of
              // completion_tokens (total = prompt + completion + reasoning), so
              // downstream billing that uses completion_tokens misses the reasoning.
              // Fold the extra into completion_tokens. No-op for standard models
              // where reasoning is already inside completion (total == prompt+completion).
              if (parsed.usage && typeof parsed.usage === "object" && parsed.usage.prompt_tokens != null) {
                const _p = Number(parsed.usage.prompt_tokens) || 0;
                const _c = Number(parsed.usage.completion_tokens) || 0;
                const _t = Number(parsed.usage.total_tokens) || 0;
                if (_t > _p + _c) {
                  parsed.usage.completion_tokens = _t - _p;
                  if (usage && typeof usage === "object") usage.completion_tokens = _t - _p;
                  output = `data: ${JSON.stringify(parsed)}\n`;
                  injectedUsage = true;
                }
              }

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, accumulatedOutputText, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch { }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          const output = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          continue;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          appendOutputText(parsed.delta.text);
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          appendOutputText(parsed.delta.thinking);
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          appendOutputText(parsed.choices[0].delta.content);
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          appendOutputText(parsed.choices[0].delta.reasoning_content);
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              appendOutputText(part.text);
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = extracted; // Keep original usage for logging

        // OpenAI Responses format (same-format passthrough): delta is a string.
        // Accumulate actual text for usage fallback
        // and Recent Requests gets a row even when upstream omits usage.
        if (typeof parsed.delta === "string" && parsed.delta) {
          if (parsed.type === "response.output_text.delta") {
            appendOutputText(parsed.delta);
            accumulatedContent += parsed.delta;
          } else if (parsed.type === "response.reasoning_summary_text.delta" || parsed.type === "response.reasoning_text.delta") {
            appendOutputText(parsed.delta);
            accumulatedThinking += parsed.delta;
          }
        }

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && hasAccumulatedOutputText()) {
              const estimated = estimateUsage(body, accumulatedOutputText, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }
        }
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          // Claude passthrough: capture usage from message_delta if present, else estimate
          if (isClaudePassthrough) {
            const claudeExtracted = extractUsage(claudeUsage ? { type: "message_delta", usage: claudeUsage } : null);
            if (claudeExtracted) usage = claudeExtracted;
            if (!hasValidUsage(usage) && hasAccumulatedOutputText()) {
              usage = estimateUsage(body, accumulatedOutputText, sourceFormat);
            }
          } else {
            if (!hasValidUsage(usage) && hasAccumulatedOutputText()) {
              usage = estimateUsage(body, accumulatedOutputText, FORMATS.OPENAI);
            }
          }

          if (hasValidUsage(usage)) {
            logUsage(provider, usage, model, connectionId, apiKey);
          } else {
            appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
          }

          // Claude passthrough stream repair: inject missing terminal events
          if (isClaudePassthrough && (claudeLastBlockIndex >= 0 || claudeMessageId)) {
            // Build a usage object for the message_delta, preferring real upstream usage
            let repairUsage = claudeUsage;
            if (!hasValidUsage(repairUsage)) {
              const estimated = estimateUsage(body, accumulatedOutputText, sourceFormat);
              repairUsage = filterUsageForFormat(estimated, sourceFormat);
            }
            if (!claudeLastBlockStopped && claudeLastBlockIndex >= 0) {
              const repair = `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: claudeLastBlockIndex })}\n\n`;
              reqLogger?.appendConvertedChunk?.(repair);
              controller.enqueue(sharedEncoder.encode(repair));
            }
            if (!claudeMessageDeltaSeen) {
              const stopReason = claudeStopReason || "end_turn";
              const deltaPayload = { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: repairUsage || { output_tokens: 0 } };
              const repair = `event: message_delta\ndata: ${JSON.stringify(deltaPayload)}\n\n`;
              reqLogger?.appendConvertedChunk?.(repair);
              controller.enqueue(sharedEncoder.encode(repair));
            }
            if (!claudeMessageStopSeen) {
              const repair = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
              reqLogger?.appendConvertedChunk?.(repair);
              controller.enqueue(sharedEncoder.encode(repair));
            }
          }

          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));

          if (onStreamComplete) {
            onStreamComplete({
              content: accumulatedContent,
              thinking: accumulatedThinking
            }, usage, ttftAt);
          }
          return;
        }

        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed && !parsed.done) {
            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                if (item === null || item === undefined) continue;
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (!keepsOpenAIResponsesFormat || !openAIResponsesDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
        }

        if (!hasValidUsage(state?.usage) && hasAccumulatedOutputText()) {
          state.usage = estimateUsage(body, accumulatedOutputText, sourceFormat);
        }

        if (hasValidUsage(state?.usage)) {
          logUsage(state.provider || targetFormat, state.usage, model, connectionId, apiKey);
        } else {
          appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
        }
        
        if (onStreamComplete) {
          onStreamComplete({
            content: accumulatedContent,
            thinking: accumulatedThinking
          }, state?.usage, ttftAt);
        }
      } catch (error) {
        console.log("Error in flush:", error);
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, sourceFormat = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    sourceFormat,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}
