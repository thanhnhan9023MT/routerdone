import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

const VALID_LIMIT_TYPES = new Set(["unlimited", "total", "daily"]);
const VALID_ALLOWED_TYPES = new Set(["all", "model", "combo"]);

// Validate the per-key limit / model-restriction payload coming from the UI.
// Returns { ok: true, value } or { ok: false, error }.
function validateKeyPolicy({ limitType, tokenLimit, allowedModels } = {}) {
  const out = {};

  if (limitType !== undefined) {
    if (!VALID_LIMIT_TYPES.has(limitType)) {
      return { ok: false, error: `limitType must be one of: ${[...VALID_LIMIT_TYPES].join(", ")}` };
    }
    out.limitType = limitType;
  }

  if (tokenLimit !== undefined) {
    const n = typeof tokenLimit === "string" ? Number(tokenLimit) : tokenLimit;
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: "tokenLimit must be a non-negative number" };
    }
    out.tokenLimit = Math.floor(n);
  }

  if (allowedModels !== undefined) {
    if (!allowedModels || typeof allowedModels !== "object") {
      return { ok: false, error: "allowedModels must be an object" };
    }
    const type = allowedModels.type || "all";
    if (!VALID_ALLOWED_TYPES.has(type)) {
      return { ok: false, error: `allowedModels.type must be one of: ${[...VALID_ALLOWED_TYPES].join(", ")}` };
    }
    const value = type === "all" ? null : typeof allowedModels.value === "string" ? allowedModels.value.trim() : null;
    if (type !== "all" && !value) {
      return { ok: false, error: `allowedModels.value is required when type="${type}"` };
    }
    out.allowedModels = { type, value };
  }

  return { ok: true, value: out };
}

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
// Body: { name, limitType?, tokenLimit?, allowedModels? }
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const policy = validateKeyPolicy({
      limitType: body.limitType,
      tokenLimit: body.tokenLimit,
      allowedModels: body.allowedModels,
    });
    if (!policy.ok) {
      return NextResponse.json({ error: policy.error }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, policy.value);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      limitType: apiKey.limitType,
      tokenLimit: apiKey.tokenLimit,
      allowedModels: apiKey.allowedModels,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
