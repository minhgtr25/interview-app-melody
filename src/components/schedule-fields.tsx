"use client";

import { useMemo, useState } from "react";
import { useServerNow } from "@/components/clock";
import { EVENT_INTERVIEW_DAYS, dayLabel, parseInterviewShift, todayInVietnam } from "@/lib/interview-days";
import type { Candidate } from "@/lib/types";

export function isFutureInterviewSlot(date: string, time: string, now: number) {
  if (!EVENT_INTERVIEW_DAYS.some((day) => day === date) || !/^\d{2}:\d{2}$/.test(time)) return false;
  const slot = new Date(`${date}T${time}:00+07:00`).getTime();
  return Number.isFinite(slot) && slot > now;
}

export function ScheduleFields({ candidates, department, date, time, onDateChange, onTimeChange, idPrefix }: {
  candidates: Pick<Candidate, "department" | "shift">[];
  department: string;
  date: string;
  time: string;
  onDateChange: (date: string) => void;
  onTimeChange: (time: string) => void;
  idPrefix: string;
}) {
  const now = useServerNow(30_000);
  const today = todayInVietnam(now);
  const [manual, setManual] = useState(false);
  const slots = useMemo(() => [...new Set(candidates
    .filter((candidate) => candidate.department === department)
    .map((candidate) => parseInterviewShift(candidate.shift))
    .filter((slot) => slot && slot.date === date && isFutureInterviewSlot(slot.date, slot.time, now))
    .map((slot) => slot!.time))].sort(), [candidates, department, date, now]);
  const custom = manual || (!!time && !slots.includes(time));
  return <div className="grid gap-3 sm:grid-cols-2">
    <label htmlFor={`${idPrefix}-date`} className="grid gap-1.5 text-sm font-medium">Ngày phỏng vấn
      <select id={`${idPrefix}-date`} className="h-10 rounded-lg border border-input bg-background px-3" value={date}
        onChange={(event) => { onDateChange(event.target.value); onTimeChange(""); setManual(false); }}>
        <option value="">Chọn ngày</option>
        {EVENT_INTERVIEW_DAYS.filter((day) => day >= today).map((day) => <option key={day} value={day}>{dayLabel(day)}</option>)}
      </select>
    </label>
    <label htmlFor={`${idPrefix}-slot`} className="grid gap-1.5 text-sm font-medium">Khung giờ
      <select id={`${idPrefix}-slot`} className="h-10 rounded-lg border border-input bg-background px-3"
        value={custom ? "CUSTOM" : time} disabled={!date}
        onChange={(event) => { setManual(event.target.value === "CUSTOM"); onTimeChange(event.target.value === "CUSTOM" ? "" : event.target.value); }}>
        <option value="">Chọn khung giờ có sẵn</option>
        {slots.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
        <option value="CUSTOM">Nhập giờ khác</option>
      </select>
    </label>
    {custom && <label htmlFor={`${idPrefix}-custom-time`} className="grid gap-1.5 text-sm font-medium sm:col-span-2">Giờ mới
      <input id={`${idPrefix}-custom-time`} type="time" className="h-10 rounded-lg border border-input bg-background px-3" value={time}
        onChange={(event) => onTimeChange(event.target.value)} />
    </label>}
    {date && time && !isFutureInterviewSlot(date, time, now) && <p className="text-sm text-destructive sm:col-span-2">Chỉ chọn giờ chưa qua theo giờ Hà Nội.</p>}
  </div>;
}
