import { NextResponse } from "next/server";
import { getRecentLogs } from "@/lib/usageDb";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const timeZone = searchParams.get("tz") || undefined;
    const logs = await getRecentLogs(200, timeZone);
    return NextResponse.json(logs);
  } catch (error) {
    console.error("Error fetching logs:", error);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
