import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

// Server-side TTL cache: usage stats don't change faster than this.
// SSE handles real-time updates; this REST endpoint just needs to be fresh-ish.
const CACHE_TTL_MS = 3000;
const cache = new Map(); // period -> { data, ts }

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const now = Date.now();
    const entry = cache.get(period);
    if (entry && now - entry.ts < CACHE_TTL_MS) {
      return NextResponse.json(entry.data);
    }

    const stats = await getUsageStats(period);
    cache.set(period, { data: stats, ts: now });
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}

// Allow cache invalidation from other modules (e.g. on saveRequestUsage)
export function invalidateStatsCache(period) {
  if (period) cache.delete(period);
  else cache.clear();
}
