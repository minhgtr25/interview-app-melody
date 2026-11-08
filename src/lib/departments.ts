export const DEPARTMENTS = [
  { code: "CM", name: "Chuyên Môn" },
  { code: "VH", name: "Văn Hóa" },
  { code: "TT", name: "Truyền Thông" },
  { code: "DE", name: "Design" },
  { code: "HCTC", name: "Hậu Cần - Thiết Công" },
] as const;

export type DepartmentCode = (typeof DEPARTMENTS)[number]["code"];

export function isDepartmentCode(value: unknown): value is DepartmentCode {
  return DEPARTMENTS.some((department) => department.code === value);
}

export function normalizeDepartment(value: string | null | undefined): DepartmentCode | null {
  const normalized = (value ?? "").trim().toUpperCase();
  if (isDepartmentCode(normalized)) return normalized;
  const aliases: Record<string, DepartmentCode> = {
    "CHUYÊN MÔN": "CM", "VĂN HÓA": "VH", "TRUYỀN THÔNG": "TT",
    DESIGN: "DE", "HẬU CẦN - THIẾT CÔNG": "HCTC",
    "BAN CHUYÊN MÔN": "CM", "BAN VĂN HÓA": "VH", "BAN TRUYỀN THÔNG": "TT",
    "BAN HẬU CẦN - THIẾT CÔNG": "HCTC", "BAN NỘI DUNG": "TT",
  };
  return aliases[normalized] ?? null;
}
