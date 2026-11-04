import { describe, expect, it } from "vitest";
import { applyMapping, autoMapHeaders } from "@/lib/excel";
import { formatDuration, normalizePhone, normalizeText, safeUrl } from "@/lib/format";

describe("formatDuration", () => {
  it("định dạng mm:ss", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(65)).toBe("01:05");
    expect(formatDuration(4503)).toBe("75:03");
    expect(formatDuration(null)).toBe("--:--");
    expect(formatDuration(-1)).toBe("--:--");
  });
});

describe("normalizeText", () => {
  it("bỏ dấu tiếng Việt", () => {
    expect(normalizeText("  Họ và Tên ")).toBe("ho va ten");
    expect(normalizeText("Đặng Đức")).toBe("dang duc");
  });
});

describe("normalizePhone", () => {
  it("bù số 0 bị Excel làm rơi", () => {
    expect(normalizePhone(901234567)).toBe("0901234567");
    expect(normalizePhone("090 123 4567")).toBe("0901234567");
    expect(normalizePhone("+84901234567")).toBe("+84901234567");
    expect(normalizePhone("")).toBeNull();
  });
});

describe("safeUrl", () => {
  it("chỉ cho phép http(s)", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("drive.google.com/file/x")).toBe("https://drive.google.com/file/x");
    expect(safeUrl("http://a.com")).toBe("http://a.com/");
    expect(safeUrl("")).toBeNull();
  });
});

describe("autoMapHeaders", () => {
  it("nhận diện cột tiếng Việt có dấu và tiếng Anh", () => {
    expect(
      autoMapHeaders(["STT", "Mã ứng viên", "Họ và tên", "Số điện thoại", "Email", "Ban ứng tuyển", "Ca phỏng vấn", "Link CV"])
    ).toEqual([null, "code", "full_name", "phone", "email", "department", "shift", "cv_url"]);
    expect(autoMapHeaders(["ID", "Full name", "Phone", "Team", "Slot", "CV"])).toEqual([
      "code", "full_name", "phone", "department", "shift", "cv_url",
    ]);
  });
  it("không gán một field cho hai cột", () => {
    const m = autoMapHeaders(["Mã", "Mã ứng viên", "Tên"]);
    expect(m.filter((x) => x === "code")).toHaveLength(1);
  });
});

describe("applyMapping", () => {
  it("lọc dòng thiếu dữ liệu, phát hiện mã trùng", () => {
    const sheet = {
      sheetName: "S",
      headers: ["Mã", "Tên", "SĐT"],
      rows: [
        ["UV1", "A", "901234567"],
        ["", "B", ""],
        ["UV2", "", ""],
        ["UV1", "A2", ""],
        ["", "", ""],
      ],
    };
    const r = applyMapping(sheet, ["code", "full_name", "phone"]);
    expect(r.valid).toHaveLength(2);
    expect(r.valid[0].phone).toBe("0901234567");
    expect(r.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(r.duplicates).toEqual(["UV1"]);
  });
});
