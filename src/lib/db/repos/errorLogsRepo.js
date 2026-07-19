import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const MAX_RECORDS = 2000;
const PRUNE_BATCH = 500;

function generateId() {
  const ts = new Date().toISOString().replace(/[-:.]/g, "");
  const rand = Math.random().toString(36).substring(2, 8);
  return `el-${ts}-${rand}`;
}

/**
 * Save an error/warn log to persistent storage.
 * Fire-and-forget safe — catches its own errors.
 */
export async function saveErrorLog({ level = "error", message = "", source = null, data = null }) {
  try {
    const db = await getAdapter();
    const id = generateId();
    const timestamp = new Date().toISOString();

    db.run(
      `INSERT INTO errorLogs(id, timestamp, level, message, source, data) VALUES(?, ?, ?, ?, ?, ?)`,
      [id, timestamp, level, message, source || null, data ? stringifyJson(data) : null]
    );

    // Prune old records if over limit
    const cnt = db.get(`SELECT COUNT(*) as c FROM errorLogs`);
    if (cnt && cnt.c > MAX_RECORDS) {
      db.run(
        `DELETE FROM errorLogs WHERE id IN (SELECT id FROM errorLogs ORDER BY timestamp ASC LIMIT ?)`,
        [Math.min(cnt.c - MAX_RECORDS + PRUNE_BATCH, PRUNE_BATCH)]
      );
    }
  } catch (e) {
    // Silently ignore — we don't want error logging to cause more errors
  }
}

/**
 * Get recent error logs, optionally since a given timestamp.
 */
export async function getErrorLogs({ limit = 200, since = null } = {}) {
  try {
    const db = await getAdapter();
    let sql = `SELECT id, timestamp, level, message, source, data FROM errorLogs`;
    const params = [];

    if (since) {
      sql += ` WHERE timestamp > ?`;
      params.push(since);
    }

    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    const rows = db.all(sql, params);
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      level: r.level,
      message: r.message,
      source: r.source,
      data: r.data ? parseJson(r.data, null) : null,
    })).reverse(); // Return chronological order
  } catch (e) {
    return [];
  }
}

/**
 * Get count of errors since a given timestamp.
 */
export async function getErrorCount({ since = null } = {}) {
  try {
    const db = await getAdapter();
    let sql = `SELECT COUNT(*) as c FROM errorLogs`;
    const params = [];
    if (since) {
      sql += ` WHERE timestamp > ?`;
      params.push(since);
    }
    const row = db.get(sql, params);
    return row ? row.c : 0;
  } catch (e) {
    return 0;
  }
}
