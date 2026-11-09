import type { DepartmentCode } from "@/lib/departments";

export const SPECIALIZATIONS_BY_DEPARTMENT = {
  CM: [
    { code: "HAT", name: "Hát" },
    { code: "NHAC_CU", name: "Nhạc cụ" },
    { code: "RAP", name: "Rap" },
  ],
  TT: [
    { code: "MEDIA", name: "Media" },
    { code: "DESIGN", name: "Design" },
    { code: "CONTENT", name: "Content" },
  ],
} as const;

export type SpecializedDepartment = keyof typeof SPECIALIZATIONS_BY_DEPARTMENT;
export type SpecializationCode = (typeof SPECIALIZATIONS_BY_DEPARTMENT)[SpecializedDepartment][number]["code"];

export function isSpecializedDepartment(department: string | null | undefined): department is SpecializedDepartment {
  return department === "CM" || department === "TT";
}

export function isSpecializationForDepartment(
  department: string | null | undefined,
  specialization: string | null | undefined,
): specialization is SpecializationCode {
  return isSpecializedDepartment(department) &&
    SPECIALIZATIONS_BY_DEPARTMENT[department].some((item) => item.code === specialization);
}

export function specializationLabel(specialization: string | null | undefined): string | null {
  if (!specialization) return null;
  for (const options of Object.values(SPECIALIZATIONS_BY_DEPARTMENT)) {
    const match = options.find((item) => item.code === specialization);
    if (match) return match.name;
  }
  return null;
}
