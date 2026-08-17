// Hostname of an upstream base URL / request URL, normalized so host-keyed rules
// actually match.
//
// Shared on purpose: rules keyed by UPSTREAM HOST (max_tokens floor in
// translator/concerns/paramSupport.js, connect timeout in config/runtimeConfig.js)
// are the durable way to describe "this upstream behaves like X" — a rule keyed by
// provider-node id dies the moment the node is recreated with a fresh UUID, measured
// 2026-08-17 when ohhmyagent's floor stopped applying after a node was re-added. Two
// copies of this normalization would drift, and each miss is silent: the rule simply
// never fires.
//
// Normalizations that matter:
//  - "host.com:8080/v1" (no scheme) → URL() throws → assume https
//  - "https://host.com./v1" (fully-qualified trailing dot) → hostname keeps the dot and
//    no host pattern ever matches
// A relative path is left unresolved on purpose: guessing an origin for it would apply
// somebody else's rule to an unknown upstream.
export function hostOf(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return "";
  const raw = baseUrl.trim();
  if (!raw || raw.startsWith("/")) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let host = "";
  try {
    host = new URL(withScheme).hostname;
  } catch {
    return "";
  }
  return host.replace(/\.$/, "").toLowerCase();
}
