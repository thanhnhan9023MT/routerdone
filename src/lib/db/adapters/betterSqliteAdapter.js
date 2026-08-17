import Database from "better-sqlite3";
import { PRAGMA_SQL } from "../schema.js";

// Periodic checkpoint to keep WAL file small (avoid huge -wal/-shm growth)
const CHECKPOINT_INTERVAL_MS = 60 * 1000;

export function createBetterSqliteAdapter(filePath) {
  const db = new Database(filePath);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  const stmtCache = new Map();

  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  // Truncate WAL periodically so file stays small for backup/copy
  const checkpointTimer = setInterval(() => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }

  // Ensure WAL is flushed and -wal/-shm files removed on shutdown
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);
  process.once("SIGINT", () => { onShutdown(); process.exit(0); });
  process.once("SIGTERM", () => { onShutdown(); process.exit(0); });

  return {
    driver: "better-sqlite3",
    run(sql, params = []) { return prepare(sql).run(params); },
    get(sql, params = []) { return prepare(sql).get(params); },
    all(sql, params = []) { return prepare(sql).all(params); },
    exec(sql) { return db.exec(sql); },
    // BEGIN IMMEDIATE, not better-sqlite3's default plain `BEGIN` (deferred).
    //
    // Every caller of transaction() in src/lib/db/repos/* is read-modify-write: it
    // SELECTs a row, merges, then UPDATEs. Under `BEGIN` that takes a read snapshot
    // first and only later asks for the write lock — and in WAL mode, if another
    // CONNECTION committed in between, SQLite fails that upgrade with
    // SQLITE_BUSY_SNAPSHOT **immediately, without invoking the busy handler**, so
    // `PRAGMA busy_timeout` (5000ms, schema.js) buys nothing at all.
    //
    // That is not theoretical here: blue and green slots both hold this same file
    // open (both must stay live for an instant switch), so there are always two
    // writers. Measured 2026-08-17 with two connections on one WAL file:
    //   BEGIN           → SQLITE_BUSY_SNAPSHOT after 0ms   (busy_timeout ignored)
    //   BEGIN IMMEDIATE → busy handler runs, waits the full timeout
    // Production symptom was `SqliteError: database is locked` (SQLITE_BUSY) thrown
    // out of updateProviderConnection/clearAccountError on the request path once
    // round-robin started writing lastUsedAt on every single request.
    //
    // IMMEDIATE takes the write lock at BEGIN, before the read, which both makes
    // busy_timeout effective and makes read-modify-write actually atomic across
    // processes instead of two slots merging from the same stale row.
    transaction(fn) { return db.transaction(fn).immediate(); },
    checkpoint() { try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
