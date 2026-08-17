import { describe, it, expect, beforeEach } from "vitest";
import {
  acquire,
  release,
  inFlight,
  hasCapacity,
  __resetForTests,
  __ageLeaseForTests,
  __STALE_LEASE_MS,
} from "../../open-sse/services/connectionConcurrency.js";

// Cổng giới hạn số request đồng thời TRÊN MỘT khoá.
//
// Lý do phải có: round-robin trong services/auth.js luân phiên theo `lastUsedAt`, mà
// mốc đó được đóng dấu lúc CHỌN và không bao giờ xoá khi request xong — nên một khoá
// đang stream vẫn trở lại "ít dùng nhất" sau khi các khoá khác lần lượt được gọi.
// Nhiều request đồng thời hơn số khoá là có khoá gánh 2 stream, và upstream chỉ cho
// 1 stream/khoá (đo trên NVIDIA NIM, 38 khoá) trả về 429 concurrency.
describe("connectionConcurrency", () => {
  beforeEach(() => __resetForTests());

  describe("acquire / release", () => {
    it("cho mượn tới đúng trần rồi từ chối", () => {
      expect(acquire("c1", 1)).toBeTruthy();
      expect(acquire("c1", 1)).toBeNull();
      expect(inFlight("c1")).toBe(1);
    });

    it("nhả xong thì mượn lại được", () => {
      const lease = acquire("c1", 1);
      expect(acquire("c1", 1)).toBeNull();
      expect(release(lease)).toBe(true);
      expect(inFlight("c1")).toBe(0);
      expect(acquire("c1", 1)).toBeTruthy();
    });

    it("trần > 1 cho nhiều lượt song song", () => {
      expect(acquire("c1", 3)).toBeTruthy();
      expect(acquire("c1", 3)).toBeTruthy();
      expect(acquire("c1", 3)).toBeTruthy();
      expect(acquire("c1", 3)).toBeNull();
      expect(inFlight("c1")).toBe(3);
    });

    it("mỗi khoá đếm riêng, không lẫn sang khoá khác", () => {
      expect(acquire("c1", 1)).toBeTruthy();
      expect(acquire("c2", 1)).toBeTruthy();
      expect(inFlight("c1")).toBe(1);
      expect(inFlight("c2")).toBe(1);
    });

    it("không trần (0 / undefined / âm) thì luôn cho mượn", () => {
      for (const limit of [0, undefined, null, -1, NaN, "x"]) {
        __resetForTests();
        expect(acquire("c1", limit)).toBeTruthy();
        expect(acquire("c1", limit)).toBeTruthy();
        expect(hasCapacity("c1", limit)).toBe(true);
      }
    });

    it("connectionId rỗng không tạo lease", () => {
      expect(acquire("", 1)).toBeNull();
      expect(acquire(null, 1)).toBeNull();
      expect(inFlight("")).toBe(0);
    });
  });

  describe("nhả trùng phải vô hại", () => {
    // Các đường nhả trong handlers/chat.js chồng nhau (stream vừa kết thúc vừa bị
    // client cancel), nên nhả 2 lần KHÔNG được giải phóng slot của request khác.
    it("nhả lần hai trả false và không mở thêm slot", () => {
      const a = acquire("c1", 1);
      expect(release(a)).toBe(true);
      const b = acquire("c1", 1);           // request khác đã chiếm slot
      expect(release(a)).toBe(false);        // nhả lại lease cũ
      expect(inFlight("c1")).toBe(1);        // slot của b còn nguyên
      expect(acquire("c1", 1)).toBeNull();
      expect(release(b)).toBe(true);
    });

    it("nhả lease rỗng/không hợp lệ không nổ", () => {
      expect(release(null)).toBe(false);
      expect(release(undefined)).toBe(false);
      expect(release({})).toBe(false);
      expect(release({ connectionId: "c1" })).toBe(false);
      expect(release({ connectionId: "kh", leaseId: "khong-co" })).toBe(false);
    });
  });

  describe("tự lành khi lease bị rò", () => {
    // Nếu một đường nhả bị bỏ sót (tiến trình chết giữa stream), khoá KHÔNG được
    // kẹt vĩnh viễn — đó là lý do có mốc quá hạn.
    it("lease quá hạn bị coi là rò và giải phóng slot", () => {
      const lease = acquire("c1", 1);
      expect(acquire("c1", 1)).toBeNull();
      __ageLeaseForTests(lease, __STALE_LEASE_MS + 1000);
      expect(inFlight("c1")).toBe(0);
      expect(acquire("c1", 1)).toBeTruthy();
    });

    it("lease chưa quá hạn vẫn giữ slot", () => {
      const lease = acquire("c1", 1);
      __ageLeaseForTests(lease, __STALE_LEASE_MS - 5000);
      expect(inFlight("c1")).toBe(1);
      expect(acquire("c1", 1)).toBeNull();
    });

    it("mốc quá hạn phải cao hơn trần stream 300s", () => {
      // combosRepo.normalizeNodeTimeouts kẹp timeout stream ở 300000ms; mốc rò phải
      // nằm trên đó, nếu không request dài hợp lệ bị tưởng là rò và khoá bị dùng đôi.
      expect(__STALE_LEASE_MS).toBeGreaterThan(300000);
    });
  });

  describe("hasCapacity", () => {
    it("đúng trạng thái trước và sau khi hết chỗ", () => {
      expect(hasCapacity("c1", 1)).toBe(true);
      const lease = acquire("c1", 1);
      expect(hasCapacity("c1", 1)).toBe(false);
      release(lease);
      expect(hasCapacity("c1", 1)).toBe(true);
    });
  });
});
