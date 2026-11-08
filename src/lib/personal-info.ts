import { normalizeText } from "@/lib/format";

export const GENDERS = [
  { code: "NAM", name: "Nam" },
  { code: "NU", name: "Nữ" },
  { code: "KHAC", name: "Khác" },
] as const;

export type GenderCode = (typeof GENDERS)[number]["code"];

export function normalizeGender(value: string | null | undefined): GenderCode | null {
  const normalized = normalizeText(value ?? "");
  if (normalized === "nam" || normalized === "male") return "NAM";
  if (normalized === "nu" || normalized === "female") return "NU";
  if (normalized === "khac" || normalized === "other") return "KHAC";
  return null;
}

export function normalizeStudentNumber(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{8}$/.test(normalized) ? normalized : null;
}
