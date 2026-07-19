const LMSTUDIO_PROFILE = "lmstudio_local";

export function resolveRuntimeProfileConfig(providerSpecificData = null) {
  const profile = providerSpecificData?.runtimeProfile === LMSTUDIO_PROFILE ? LMSTUDIO_PROFILE : "standard";
  if (profile !== LMSTUDIO_PROFILE) return { profile };
  return {
    profile,
    stream: { firstByteTimeoutMs: 15000, firstProductiveTimeoutMs: 60000, idleAfterProductiveMs: 120000 },
    heartbeat: { enabled: true, intervalMs: 15000 },
  };
}

export function normalizeLmstudioMessages(body, providerSpecificData = null) {
  if (resolveRuntimeProfileConfig(providerSpecificData).profile !== LMSTUDIO_PROFILE || !Array.isArray(body?.messages)) return body;
  return {
    ...body,
    messages: body.messages.map(message => {
      if (!Array.isArray(message?.content)) return message;
      const text = message.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
      return text ? { ...message, content: text } : message;
    }),
  };
}
