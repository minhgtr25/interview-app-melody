import { describe, expect, it } from "vitest";
import { candidateApplicationDay, candidateApplicationNote, candidateApplicationShift } from "@/lib/candidate-application-day";
import { createCandidateApplicationStatusResolver } from "@/lib/candidate-application-status";
import type { Candidate, Evaluation } from "@/lib/types";

const root = {
  id: "first", shift: "10/11/2026 19:00 (CM)", department: "CM", source_candidate_id: null,
  status: "COMPLETED", interview_started_at: "2026-11-09T12:00:00Z",
  interview_ended_at: "2026-11-09T12:30:00Z", interview_note: null,
} as Candidate;
const second = {
  id: "second", shift: "10/11/2026 20:00 (VH)", department: "VH", source_candidate_id: "first",
  status: "NOT_ARRIVED", interview_started_at: null, interview_ended_at: null, interview_note: null,
} as Candidate;
const firstEvaluation = {
  candidate_id: "first", started_at: "2026-11-09T12:00:00Z", ended_at: "2026-11-09T12:30:00Z",
} as Evaluation;

describe("per-application interview day", () => {
  it("places a completed early interview on its actual day and keeps the next application on its scheduled day", () => {
    const status = createCandidateApplicationStatusResolver([root, second], [firstEvaluation]);
    expect(candidateApplicationDay(root, firstEvaluation)).toBe("2026-11-09");
    expect(candidateApplicationShift(root, firstEvaluation)).toBe("09/11/2026 19:00 (CM)");
    expect(candidateApplicationNote(root, firstEvaluation)).toContain("lịch ban đầu: 10/11/2026");
    expect(status(root)).toBe("COMPLETED");
    expect(candidateApplicationDay(second)).toBe("2026-11-10");
    expect(candidateApplicationShift(second)).toBe("10/11/2026 20:00 (VH)");
    expect(status(second)).toBe("NOT_ARRIVED");
  });

  it("does not borrow an earlier evaluation from a linked application", () => {
    const staleSecond = { ...second, status: "COMPLETED" as const };
    const status = createCandidateApplicationStatusResolver([root, staleSecond], [firstEvaluation]);
    expect(candidateApplicationDay(staleSecond)).toBe("2026-11-10");
    expect(status(staleSecond)).toBe("NOT_ARRIVED");
  });

  it("keeps a completed interview on a different event day separate from its sibling", () => {
    const completedSecond = {
      ...second, status: "COMPLETED" as const, interview_started_at: "2026-11-10T12:00:00Z",
    };
    const secondEvaluation = { candidate_id: "second", started_at: "2026-11-10T12:00:00Z" } as Evaluation;
    expect(candidateApplicationDay(completedSecond, secondEvaluation)).toBe("2026-11-10");
    expect(candidateApplicationDay(root, firstEvaluation)).toBe("2026-11-09");
  });
});
