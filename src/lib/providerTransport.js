const ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/responses",
  "/models",
  "/messages",
  "/embeddings",
  "/api/chat",
  "/api/generate",
];

export const RUNTIME_PROFILES = new Set(["standard", "lmstudio_local"]);

export function normalizeRuntimeProfile(value) {
  return value === "lmstudio_local" ? "lmstudio_local" : "standard";
}

export function normalizeProviderBaseUrl(baseUrl, { runtimeProfile = "standard", transport = "openai" } = {}) {
  const raw = String(baseUrl || "").trim();
  if (!raw) throw new Error("Base URL required");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL format");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL protocol must be http or https");
  }
  if (!url.hostname) throw new Error("URL host required");
  if (url.username || url.password) throw new Error("URL credentials not allowed");
  if (url.hash) url.hash = "";

  let pathname = url.pathname.replace(/\/+$/, "");
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (pathname === suffix || pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length) || "";
      break;
    }
  }

  if (normalizeRuntimeProfile(runtimeProfile) === "lmstudio_local" && transport === "openai" && !pathname.endsWith("/v1")) {
    pathname = `${pathname}/v1`.replace(/\/+/g, "/");
  }

  url.pathname = pathname || "/";
  const normalized = url.toString().replace(/\/$/, "");
  return normalized;
}

export function buildProviderEndpoint(baseUrl, path, opts = {}) {
  const normalized = normalizeProviderBaseUrl(baseUrl, opts);
  return `${normalized}${path.startsWith("/") ? path : `/${path}`}`;
}
