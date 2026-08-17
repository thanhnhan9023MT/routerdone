import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.js";

// SQLITE_BUSY trên prod (2026-08-17): `SqliteError: database is locked` bay ra khỏi
// updateProviderConnection / clearAccountError ngay trên đường request.
//
// Gốc KHÔNG phải busy_timeout quá ngắn. `db.transaction()` của better-sqlite3 mặc định
// là `BEGIN` (deferred): thân transaction ĐỌC trước rồi mới GHI, nên trong WAL, nếu một
// KẾT NỐI khác đã commit giữa hai bước đó, SQLite bắn SQLITE_BUSY_SNAPSHOT **tức thì và
// KHÔNG gọi busy handler** → `PRAGMA busy_timeout` vô tác dụng hoàn toàn.
//
// Ở đây luôn có hai kết nối ghi thật: slot blue và slot green cùng mở một file
// data.sqlite (cả hai phải sống để chuyển slot tức thì). Round-robin ghi `lastUsedAt`
// mỗi request nên cửa sổ này bị đụng liên tục.
describe("db adapter · transaction phải là BEGIN IMMEDIATE", () => {
  const dirs = [];

  function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-tx-"));
    dirs.push(dir);
    return path.join(dir, "data.sqlite");
  }

  // Kết nối "slot kia". busy_timeout cực ngắn để test không phải chờ thật.
  function otherConnection(file) {
    const db = new Database(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 50;");
    return db;
  }

  function tryWrite(conn, value) {
    try {
      conn.prepare("UPDATE t SET v=? WHERE id=1").run(value);
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e.code };
    }
  }

  afterEach(() => {
    while (dirs.length) {
      try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch {}
    }
  });

  it("khoá ghi được giữ NGAY TỪ BEGIN, dù thân transaction mới chỉ đọc", () => {
    // Đây là phép thử phân biệt hai chế độ. Deferred: lúc này chưa có khoá ghi nào nên
    // kết nối kia GHI ĐƯỢC — và chính điều đó tạo ra cửa sổ làm bước UPDATE của mình
    // sau đó vỡ bằng SQLITE_BUSY_SNAPSHOT. Immediate: khoá đã trong tay từ BEGIN.
    const file = tempFile();
    const adapter = createBetterSqliteAdapter(file);
    const other = otherConnection(file);
    try {
      adapter.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      adapter.run("INSERT INTO t(id,v) VALUES(?,?)", [1, "ban-dau"]);
      let otherResult;
      adapter.transaction(() => {
        adapter.get("SELECT v FROM t WHERE id=1");   // CHỈ đọc, chưa ghi gì
        otherResult = tryWrite(other, "tu-slot-kia");
      });
      expect(otherResult.ok).toBe(false);
      expect(otherResult.code).toMatch(/SQLITE_BUSY/);
    } finally {
      try { other.close(); } catch {}
      try { adapter.close(); } catch {}
    }
  });

  it("kết nối kia commit TRƯỚC thì đọc-rồi-ghi vẫn xong và ghi của mình là bản cuối", () => {
    // Đây là hình dạng thật trên prod: slot kia commit xong, rồi tới lượt mình.
    const file = tempFile();
    const adapter = createBetterSqliteAdapter(file);
    const other = otherConnection(file);
    try {
      adapter.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      adapter.run("INSERT INTO t(id,v) VALUES(?,?)", [1, "ban-dau"]);
      expect(tryWrite(other, "tu-slot-kia").ok).toBe(true);
      adapter.transaction(() => {
        const seen = adapter.get("SELECT v FROM t WHERE id=1")?.v;
        // Khoá ghi đã giữ từ BEGIN nên bản đọc được là bản MỚI NHẤT, không phải dòng cũ.
        expect(seen).toBe("tu-slot-kia");
        adapter.run("UPDATE t SET v=? WHERE id=1", ["tu-slot-minh"]);
      });
      expect(adapter.get("SELECT v FROM t WHERE id=1")?.v).toBe("tu-slot-minh");
    } finally {
      try { other.close(); } catch {}
      try { adapter.close(); } catch {}
    }
  });

  it("GHI LẠI GỐC: `BEGIN` deferred vỡ TỨC THÌ và bỏ qua busy_timeout", () => {
    // Neo lại đúng giả định đã dẫn tới bản vá. Nếu ngày nào better-sqlite3/SQLite đổi
    // hành vi này thì test đỏ và người sau biết lý do BEGIN IMMEDIATE còn cần nữa không.
    const file = tempFile();
    const a = new Database(file);
    a.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    a.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    a.exec("INSERT INTO t(id,v) VALUES(1,'ban-dau')");
    const b = otherConnection(file);
    try {
      a.exec("BEGIN");                                        // deferred
      a.prepare("SELECT v FROM t WHERE id=1").get();          // chốt snapshot đọc
      expect(tryWrite(b, "tu-slot-kia").ok).toBe(true);        // kia chen vào ĐƯỢC
      const t0 = Date.now();
      const mine = tryWrite(a, "tu-slot-minh");                // nâng lên ghi → vỡ
      const waited = Date.now() - t0;
      expect(mine.ok).toBe(false);
      expect(mine.code).toBe("SQLITE_BUSY_SNAPSHOT");
      expect(waited).toBeLessThan(1000);                       // busy_timeout 5000 bị bỏ qua
    } finally {
      try { a.exec("ROLLBACK"); } catch {}
      try { b.close(); } catch {}
      try { a.close(); } catch {}
    }
  });

  it("thân transaction ném lỗi thì rollback, không để treo transaction", () => {
    const file = tempFile();
    const adapter = createBetterSqliteAdapter(file);
    try {
      adapter.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      adapter.run("INSERT INTO t(id,v) VALUES(?,?)", [1, "ban-dau"]);
      expect(() => adapter.transaction(() => {
        adapter.run("UPDATE t SET v=? WHERE id=1", ["nua-doi"]);
        throw new Error("vỡ giữa transaction");
      })).toThrow("vỡ giữa transaction");
      expect(adapter.get("SELECT v FROM t WHERE id=1")?.v).toBe("ban-dau");
      // Transaction sau vẫn mở được — nếu cái trước còn treo thì đây sẽ ném.
      adapter.transaction(() => adapter.run("UPDATE t SET v=? WHERE id=1", ["sau-loi"]));
      expect(adapter.get("SELECT v FROM t WHERE id=1")?.v).toBe("sau-loi");
    } finally {
      try { adapter.close(); } catch {}
    }
  });

  it("transaction lồng nhau vẫn chạy (better-sqlite3 tự dùng savepoint)", () => {
    const file = tempFile();
    const adapter = createBetterSqliteAdapter(file);
    try {
      adapter.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      adapter.transaction(() => {
        adapter.run("INSERT INTO t(id,v) VALUES(?,?)", [1, "ngoai"]);
        adapter.transaction(() => {
          adapter.run("UPDATE t SET v=? WHERE id=1", ["trong"]);
        });
      });
      expect(adapter.get("SELECT v FROM t WHERE id=1")?.v).toBe("trong");
    } finally {
      try { adapter.close(); } catch {}
    }
  });
});
