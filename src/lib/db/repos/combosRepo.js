import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Per-combo reasoning first-productive timeout: NULL (use global default) or an
// int in [4000, 300000] ms. Anything invalid/blank/≤0 → null. Single source of
// truth for valid values across every write path.
export function normalizeReasoningTimeoutMs(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(Math.round(n), 4000), 300000);
}

// Per-node stream timeout override: a map { "<node-ref>": <ms> }. Each value is clamped
// to [1000, 300000] ms; blank/invalid values and keys not present in `models` are dropped.
// Returns null when nothing valid remains.
export function normalizeNodeTimeouts(v, models) {
  if (v === null || v === undefined || v === "") return null;
  let obj = v;
  if (typeof v === "string") { try { obj = JSON.parse(v); } catch { return null; } }
  if (typeof obj !== "object" || Array.isArray(obj)) return null;
  const allowed = Array.isArray(models) ? new Set(models.filter((m) => typeof m === "string")) : null;
  const out = {};
  for (const [k, raw] of Object.entries(obj)) {
    if (allowed && !allowed.has(k)) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    out[k] = Math.min(Math.max(Math.round(n), 1000), 300000);
  }
  return Object.keys(out).length ? out : null;
}

// External vision handler: a non-empty `prefix/model` or combo name, else null.
export function normalizeVisionModel(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s || null;
}

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    outputModel: row.outputModel || null,
    stripReasoning: row.stripReasoning ? true : false,
    reasoningTimeoutMs: row.reasoningTimeoutMs ?? null,
    visionModel: row.visionModel || null,
    pdfModel: row.pdfModel || null,
    nodeTimeouts: parseJson(row.nodeTimeouts, null),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    reasoningTimeoutMs: normalizeReasoningTimeoutMs(data.reasoningTimeoutMs),
    visionModel: normalizeVisionModel(data.visionModel),
    pdfModel: normalizeVisionModel(data.pdfModel),
    nodeTimeouts: normalizeNodeTimeouts(data.nodeTimeouts, data.models || []),
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, reasoningTimeoutMs, visionModel, pdfModel, nodeTimeouts, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.reasoningTimeoutMs, combo.visionModel, combo.pdfModel, combo.nodeTimeouts ? stringifyJson(combo.nodeTimeouts) : null, combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToCombo(row);
    const merged = { ...current, ...data, updatedAt: new Date().toISOString() };
    // Only re-normalize when the caller actually sent the field, else preserve existing.
    const rtm = ("reasoningTimeoutMs" in data)
      ? normalizeReasoningTimeoutMs(data.reasoningTimeoutMs)
      : (current.reasoningTimeoutMs ?? null);
    const vm = ("visionModel" in data)
      ? normalizeVisionModel(data.visionModel)
      : (current.visionModel ?? null);
    const pm = ("pdfModel" in data)
      ? normalizeVisionModel(data.pdfModel)
      : (current.pdfModel ?? null);
    const ntm = ("nodeTimeouts" in data)
      ? normalizeNodeTimeouts(data.nodeTimeouts, merged.models || [])
      : (current.nodeTimeouts ?? null);
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, reasoningTimeoutMs = ?, visionModel = ?, pdfModel = ?, nodeTimeouts = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), rtm, vm, pm, ntm ? stringifyJson(ntm) : null, merged.updatedAt, id]
    );
    merged.reasoningTimeoutMs = rtm;
    merged.nodeTimeouts = ntm;
    merged.visionModel = vm;
    merged.pdfModel = pm;
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
