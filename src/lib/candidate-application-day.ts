import type { Candidate, Evaluation } from "@/lib/types";
import { dayLabel, interviewDate, parseInterviewShift } from "@/lib/interview-days";

function vietnamDay(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(timestamp);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** One application's own interview result determines its day; linked rounds never inherit the parent's day. */
export function candidateApplicationDay(candidate: Candidate, evaluation?: Evaluation | null) {
  const scheduledDay = interviewDate(candidate);
  const hasInterview = Boolean(evaluation || candidate.status === "COMPLETED" || candidate.challenge_status);
  if (!hasInterview) return scheduledDay;
  const actualDay = vietnamDay(
    evaluation?.started_at ?? candidate.interview_started_at ?? evaluation?.ended_at ?? candidate.interview_ended_at,
  );
  return actualDay ?? scheduledDay;
}

export function candidateApplicationShift(candidate: Candidate, evaluation?: Evaluation | null) {
  const parsed = parseInterviewShift(candidate.shift);
  const day = candidateApplicationDay(candidate, evaluation);
  if (!parsed || !day || day === parsed.date) return candidate.shift;
  return `${dayLabel(day)}${candidate.shift!.slice(10)}`;
}

export function candidateApplicationNote(candidate: Candidate, evaluation?: Evaluation | null) {
  if (candidate.interview_note) return candidate.interview_note;
  const scheduledDay = interviewDate(candidate);
  const actualDay = candidateApplicationDay(candidate, evaluation);
  if (scheduledDay && actualDay && actualDay < scheduledDay) {
    return `Phỏng vấn sớm ngày ${dayLabel(actualDay)} (lịch ban đầu: ${dayLabel(scheduledDay)})`;
  }
  return null;
}
