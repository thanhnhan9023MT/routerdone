import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// Defaults for the per-key token limit policy. Used when a row lacks the
// column (older DBs) or when createApiKey is called without opts.
const DEFAULT_LIMIT_TYPE = "unlimited";
const DEFAULT_TOKEN_LIMIT = 0;
const DEFAULT_ALLOWED_MODELS = { type: "all", value: null };

function parseAllowedModels(raw) {
  if (!raw) return { ...DEFAULT_ALLOWED_MODELS };
  if (typeof raw === "object") return { ...DEFAULT_ALLOWED_MODELS, ...raw };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { ...DEFAULT_ALLOWED_MODELS, ...parsed };
    }
  } catch {
    // fall through to default
  }
  return { ...DEFAULT_ALLOWED_MODELS };
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    limitType: row.limitType ?? DEFAULT_LIMIT_TYPE,
    tokenLimit: row.tokenLimit ?? DEFAULT_TOKEN_LIMIT,
    usedTokens: row.usedTokens ?? 0,
    usedDailyTokens: row.usedDailyTokens ?? 0,
    usedDailyDateKey: row.usedDailyDateKey ?? null,
    allowedModels: parseAllowedModels(row.allowedModels),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Lookup by the raw key string (the value sent in Authorization / x-api-key).
// Used by the request flow to load the full record (id + limit policy) at the
// auth gate, so the quota/model-restriction checks have everything they need.
export async function getApiKeyByRawKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

function normalizeAllowedModels(input) {
  if (!input || typeof input !== "object") return { ...DEFAULT_ALLOWED_MODELS };
  const type = ["all", "model", "combo"].includes(input.type) ? input.type : "all";
  const value = type === "all" ? null : typeof input.value === "string" ? input.value : null;
  return { type, value };
}

function withLimitDefaults(opts = {}) {
  const limitType = ["unlimited", "total", "daily"].includes(opts.limitType)
    ? opts.limitType
    : DEFAULT_LIMIT_TYPE;
  const tokenLimit =
    typeof opts.tokenLimit === "number" && Number.isFinite(opts.tokenLimit) && opts.tokenLimit >= 0
      ? Math.floor(opts.tokenLimit)
      : DEFAULT_TOKEN_LIMIT;
  const allowedModels = normalizeAllowedModels(opts.allowedModels);
  return { limitType, tokenLimit, allowedModels };
}

export async function createApiKey(name, machineId, opts = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const { limitType, tokenLimit, allowedModels } = withLimitDefaults(opts);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    limitType,
    tokenLimit,
    usedTokens: 0,
    usedDailyTokens: 0,
    usedDailyDateKey: null,
    allowedModels,
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, limitType, tokenLimit, usedTokens, usedDailyTokens, usedDailyDateKey, allowedModels)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id,
      apiKey.key,
      apiKey.name,
      apiKey.machineId,
      1,
      apiKey.createdAt,
      apiKey.limitType,
      apiKey.tokenLimit,
      0,
      0,
      null,
      JSON.stringify(apiKey.allowedModels),
    ]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToKey(row);
    const merged = {
      ...current,
      ...data,
      allowedModels:
        data.allowedModels !== undefined
          ? normalizeAllowedModels(data.allowedModels)
          : current.allowedModels,
    };
    db.run(
      `UPDATE apiKeys
       SET key = ?, name = ?, machineId = ?, isActive = ?,
           limitType = ?, tokenLimit = ?, allowedModels = ?
       WHERE id = ?`,
      [
        merged.key,
        merged.name,
        merged.machineId,
        merged.isActive ? 1 : 0,
        merged.limitType,
        merged.tokenLimit,
        JSON.stringify(merged.allowedModels),
        id,
      ]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

// Atomic usage increment for a key, called from within saveRequestUsage tx.
// Both lifetime and daily counters update together; when the date key rolls
// over (new local day per tz config), the daily counter resets to this delta.
// Returns the updated record (or null when the raw key is not a managed row,
// e.g. local-mode / CLI-token requests that bypass the apiKeys table).
export async function incrementApiKeyUsage({ apiKey, totalTokens, dateKey }) {
  if (!apiKey) return null;
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [apiKey]);
    if (!row) return;
    const current = rowToKey(row);
    const sameDay = current.usedDailyDateKey && current.usedDailyDateKey === dateKey;
    const nextDaily = sameDay ? current.usedDailyTokens + totalTokens : totalTokens;
    const nextDailyDateKey = sameDay ? current.usedDailyDateKey : dateKey;
    const nextLifetime = (current.usedTokens || 0) + totalTokens;
    db.run(
      `UPDATE apiKeys
       SET usedTokens = ?, usedDailyTokens = ?, usedDailyDateKey = ?
       WHERE id = ?`,
      [nextLifetime, nextDaily, nextDailyDateKey, current.id]
    );
    result = {
      ...current,
      usedTokens: nextLifetime,
      usedDailyTokens: nextDaily,
      usedDailyDateKey: nextDailyDateKey,
    };
  });
  return result;
}

// Manual reset (admin action from the key-limit UI). scope:
// 'all' -> lifetime + daily; 'total' -> lifetime only; 'daily' -> daily only.
export async function resetApiKeyUsage(id, scope = "all") {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToKey(row);
    const next = { ...current };
    if (scope === "all" || scope === "total") next.usedTokens = 0;
    if (scope === "all" || scope === "daily") {
      next.usedDailyTokens = 0;
      next.usedDailyDateKey = null;
    }
    db.run(
      `UPDATE apiKeys
       SET usedTokens = ?, usedDailyTokens = ?, usedDailyDateKey = ?
       WHERE id = ?`,
      [next.usedTokens, next.usedDailyTokens, next.usedDailyDateKey, id]
    );
    result = next;
  });
  return result;
}
