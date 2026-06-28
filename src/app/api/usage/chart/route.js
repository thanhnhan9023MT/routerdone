import { NextResponse } from "next/server";
import { getChartData } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);

// Server-side TTL cache: chart data changes infrequently, 5s TTL is fine.
const CACHE_TTL_MS = 5000;
const cache = new Map(); // `${period}|${timeZone}` -> { data, ts }

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const timeZone = searchParams.get("tz") || undefined;

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const now = Date.now();
    const cacheKey = `${period}|${timeZone || "server"}`;
    const entry = cache.get(cacheKey);
    if (entry && now - entry.ts < CACHE_TTL_MS) {
      return NextResponse.json(entry.data);
    }

    const data = await getChartData(period, timeZone);
    cache.set(cacheKey, { data, ts: now });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 });
  }
}
