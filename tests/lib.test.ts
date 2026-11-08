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
  it("nhận diện đúng cột cá nhân trong Google Form và bỏ câu hỏi chuyên môn", () => {
    expect(autoMapHeaders([
      "Timestamp", "Họ và tên của bạn?", "Bạn là sinh viên khóa?", "Giới tính",
      "Mã số sinh viên của bạn?", "Email của bạn (email cá nhân)", "Số điện thoại của bạn",
      "Link Facebook của bạn", "Bạn đã biết gì về CLB?", "Bạn đăng ký Ban nào",
      "Bạn biết gì về ban Chuyên môn?", "Ca phỏng vấn", "Link Drive video tài năng",
    ])).toEqual([
      null, "full_name", "student_cohort", "gender", "student_number", "email", "phone",
      "facebook_url", null, "department", null, null, null,
    ]);
  });
  it("không gán một field cho hai cột", () => {
    const m = autoMapHeaders(["MSSV", "Mã số sinh viên của bạn?", "Tên"]);
    expect(m.filter((x) => x === "student_number")).toHaveLength(1);
  });
  it("không dùng STT và dấu thời gian của Google Form làm dữ liệu cá nhân", () => {
    expect(autoMapHeaders(["Dấu thời gian", "STT", "Họ và tên", "Ban ứng tuyển"])).toEqual([
      null, null, "full_name", "department",
    ]);
  });
});

describe("applyMapping", () => {
  it("lọc dòng thiếu dữ liệu, chuẩn hóa Ban và phát hiện MSSV trùng", () => {
    const sheet = {
      sheetName: "S",
      headers: ["MSSV", "Tên", "Giới tính", "SĐT", "Ban"],
      rows: [
        ["HE123456", "A", "Nam", "901234567", "Ban Chuyên Môn"],
        ["", "B", "Nữ", "", "CM"],
        ["HE123457", "", "Nam", "", "CM"],
        ["HE123456", "A2", "Nữ", "", "CM"],
        ["HE123458", "C", "Nam", "", "Ban không hợp lệ"],
        ["HE123459", "D", "Nữ", "", "Ban Nội Dung"],
      ],
    };
    const r = applyMapping(sheet, ["student_number", "full_name", "gender", "phone", "department"]);
    expect(r.valid).toHaveLength(3);
    expect(r.valid[0].phone).toBe("0901234567");
    expect(r.valid[0].department).toBe("CM");
    expect(r.valid[2].department).toBe("TT");
    expect(r.errors.map((e) => e.row)).toEqual([3, 4, 6]);
    expect(r.duplicates).toEqual(["HE123456"]);
  });
});
