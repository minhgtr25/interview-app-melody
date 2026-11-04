"use client";

import { DEPARTMENTS, type DepartmentCode } from "@/lib/departments";
import { cn } from "@/lib/utils";

export function DepartmentRadio({ name, value, onChange, allowAll = false, disabled = false }: {
  name: string;
  value: DepartmentCode | "";
  onChange: (value: DepartmentCode | "") => void;
  allowAll?: boolean;
  disabled?: boolean;
}) {
  const options: { code: DepartmentCode | ""; name: string }[] = [
    ...(allowAll ? [{ code: "" as const, name: "Tất cả ban" }] : []),
    ...DEPARTMENTS,
  ];
  return (
    <fieldset className="flex flex-wrap gap-1.5" aria-label="Chọn ban">
      {options.map((option) => (
        <label key={option.code || "all"} className={cn(
          "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
          value === option.code ? "border-primary bg-primary/10 font-semibold text-primary" : "border-input hover:bg-muted",
          disabled && "cursor-not-allowed opacity-50"
        )}>
          <input type="radio" name={name} value={option.code} checked={value === option.code}
            onChange={() => onChange(option.code)} disabled={disabled} className="accent-primary" />
          <span>{option.code ? `${option.code} - ${option.name}` : option.name}</span>
        </label>
      ))}
    </fieldset>
  );
}
