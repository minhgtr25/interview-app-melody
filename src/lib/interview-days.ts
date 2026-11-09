import type { Candidate } from "@/lib/types";

const SHIFT_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}) \((CM|VH|TT|ND|HCTC)\)$/;
export const EVENT_INTERVIEW_DAYS = ["2026-11-09", "2026-11-10", "2026-11-11"] as const;

export function parseInterviewShift(shift: string | null | undefined) {
  const match = shift?.match(SHIFT_PATTERN);
  if (!match) return null;
  const [, day, month, year, hour, minute, department] = match;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T${hour}:${minute}:00+07:00`);
  if (Number(day) < 1 || Number(month) < 1 || Number(hour) > 23 || Number(minute) > 59 ||
    Number.isNaN(parsed.getTime()) ||
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).toISOString().slice(0, 10) !== date) return null;
  return { date, time: `${hour}:${minute}`, department };
}

export function interviewDate(candidate: Pick<Candidate, "shift">) {
  return parseInterviewShift(candidate.shift)?.date ?? null;
}

export function interviewDays(candidates: Pick<Candidate, "shift">[]) {
  return [...new Set(candidates.map(interviewDate).filter((date): date is string => !!date))].sort();
}

export function todayInVietnam(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function dayLabel(date: string) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

export function makeInterviewShift(date: string, time: string, department: string) {
  const shift = `${dayLabel(date)} ${time} (${department})`;
  if (parseInterviewShift(shift)?.department !== department) throw new Error("Ca phỏng vấn không hợp lệ");
  return shift;
}
