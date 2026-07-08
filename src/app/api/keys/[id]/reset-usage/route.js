import { NextResponse } from "next/server";
import { getApiKeyById, resetApiKeyUsage } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const VALID_SCOPES = new Set(["all", "total", "daily"]);

// POST /api/keys/[id]/reset-usage
// Body: { scope?: 'all' | 'total' | 'daily' }   (default: 'all')
// Resets the cached usage counters on the key (admin action from the
// key-limit UI). The raw usageHistory rows are NOT touched — only the
// per-key counters used by the quota pre-check.
export async function POST(request, { params }) {
  try {
    const { id } = await params;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    let scope = "all";
    try {
      const body = await request.json();
      if (body && body.scope) scope = body.scope;
    } catch {
      // Empty body is fine — default to 'all'.
    }
    if (!VALID_SCOPES.has(scope)) {
      return NextResponse.json({ error: `scope must be one of: ${[...VALID_SCOPES].join(", ")}` }, { status: 400 });
    }

    const updated = await resetApiKeyUsage(id, scope);
    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error resetting key usage:", error);
    return NextResponse.json({ error: "Failed to reset key usage" }, { status: 500 });
  }
}
