// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { fetchConnectionUsage, refreshAndUpdateCredentials } from "../_shared";

// Re-export so existing importers (claudeAutoPing.js, codex-reset-credits)
// keep working without changing their import paths.
export { refreshAndUpdateCredentials };

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  const { connectionId } = await params;
  const result = await fetchConnectionUsage(connectionId);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status || 500 });
  }
  return Response.json(result.data);
}