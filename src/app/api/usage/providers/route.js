import { NextResponse } from "next/server";
import { getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";
import { getAdapter } from "@/lib/db/driver.js";

/**
 * GET /api/usage/providers
 * Returns list of unique providers from usageHistory (DISTINCT query, no full scan)
 */
export async function GET() {
  try {
    const db = await getAdapter();

    // Extract unique providers via DISTINCT query instead of fetching all details
    const rows = db.all(`SELECT DISTINCT provider FROM usageHistory WHERE provider IS NOT NULL AND provider != ''`);
    const providerAliases = [...new Set(rows.map(r => r.provider))].sort();

    const providerNodes = await getProviderNodes();
    const nodeMap = Object.fromEntries(providerNodes.map(n => [n.id, n.name]));

    const providers = providerAliases.map(alias => {
      const name = nodeMap[alias] || getProviderByAlias(alias)?.name || AI_PROVIDERS[alias]?.name || alias;
      return { id: alias, name };
    });

    return NextResponse.json({ providers });
  } catch (e) {
    console.error("[API] Failed to get providers:", e);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}
