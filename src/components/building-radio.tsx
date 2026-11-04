"use client";

import { BUILDINGS, type BuildingCode } from "@/lib/rooms";
import { cn } from "@/lib/utils";

export function BuildingRadio({ name, value, onChange, disabled = false }: {
  name: string;
  value: BuildingCode | "";
  onChange: (value: BuildingCode) => void;
  disabled?: boolean;
}) {
  return <fieldset className="flex flex-wrap gap-1.5" aria-label="Chọn tòa học">
    {BUILDINGS.map((building) => <label key={building.code} className={cn(
      "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm",
      value === building.code ? "border-primary bg-primary/10 font-semibold text-primary" : "border-input hover:bg-muted",
      disabled && "cursor-not-allowed opacity-50"
    )}>
      <input type="radio" name={name} value={building.code} checked={value === building.code}
        onChange={() => onChange(building.code)} disabled={disabled} className="accent-primary" />
      {building.code} - {building.name}
    </label>)}
  </fieldset>;
}
