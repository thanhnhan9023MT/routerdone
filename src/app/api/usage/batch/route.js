import { fetchConnectionUsage } from "../_shared";

const MAX_BATCH_SIZE = 100;

function normalizeConnectionIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  return [...new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean))]
    .slice(0, MAX_BATCH_SIZE);
}

/**
 * POST /api/usage/batch
 * Body: { connectionIds: string[] }
 *
 * Moves the quota fan-out from browser to server. The client sends one
 * request, then the server fetches all connection quotas concurrently and
 * returns isolated per-connection results.
 */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const connectionIds = normalizeConnectionIds(body.connectionIds);
  if (connectionIds.length === 0) {
    return Response.json({ results: {}, requested: 0 });
  }

  const entries = await Promise.all(
    connectionIds.map(async (connectionId) => [
      connectionId,
      await fetchConnectionUsage(connectionId),
    ]),
  );

  return Response.json({
    results: Object.fromEntries(entries),
    requested: connectionIds.length,
  });
}