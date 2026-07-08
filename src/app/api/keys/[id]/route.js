import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";

const VALID_LIMIT_TYPES = new Set(["unlimited", "total", "daily"]);
const VALID_ALLOWED_TYPES = new Set(["all", "model", "combo"]);

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

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
// Body accepts: { isActive?, name?, limitType?, tokenLimit?, allowedModels? }
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (body.isActive !== undefined) updateData.isActive = body.isActive;
    if (body.name !== undefined) updateData.name = body.name;

    const policy = validateKeyPolicy({
      limitType: body.limitType,
      tokenLimit: body.tokenLimit,
      allowedModels: body.allowedModels,
    });
    if (!policy.ok) {
      return NextResponse.json({ error: policy.error }, { status: 400 });
    }
    Object.assign(updateData, policy.value);

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
