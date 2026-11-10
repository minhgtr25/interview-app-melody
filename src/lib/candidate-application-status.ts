import type { Candidate, CandidateStatus, Evaluation } from "@/lib/types";
import { interviewDate } from "@/lib/interview-days";

function vietnamDate(value: string | null | undefined) {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (name: string) => parts.find((part) => part.type === name)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Resolve stale attendance on a linked application without borrowing its parent's result. */
export function createCandidateApplicationStatusResolver(candidates: Candidate[], evaluations: Evaluation[]) {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const evaluationByCandidate = new Map(evaluations.map((evaluation) => [evaluation.candidate_id, evaluation]));

  return (candidate: Candidate): CandidateStatus => {
    const ownEvaluation = evaluationByCandidate.get(candidate.id);
    if (ownEvaluation) {
      if (!candidate.challenge_status && candidate.status !== "ASSIGNED" && candidate.status !== "INTERVIEWING") {
        return "COMPLETED";
      }
      return candidate.status;
    }
    if (!candidate.source_candidate_id) return candidate.status;
    if (candidate.status === "ASSIGNED" || candidate.status === "INTERVIEWING") return candidate.status;

    const scheduledDay = interviewDate(candidate);
    if (!scheduledDay) return candidate.status;

    const parent = candidateById.get(candidate.source_candidate_id);
    const parentEvaluation = parent && evaluationByCandidate.get(parent.id);
    const parentCompletionDay = vietnamDate(parentEvaluation?.ended_at ?? parent?.interview_ended_at);
    const absentDay = vietnamDate(candidate.absent_at);

    if (candidate.status === "ABSENT" &&
      ((absentDay && absentDay < scheduledDay) || (!absentDay && parentCompletionDay && parentCompletionDay < scheduledDay))) {
      return "NOT_ARRIVED";
    }
    if (candidate.status === "COMPLETED" && parentCompletionDay && parentCompletionDay < scheduledDay) {
      return "NOT_ARRIVED";
    }
    const checkedInDay = vietnamDate(candidate.checked_in_at);
    if (candidate.status === "CHECKED_IN" && parentCompletionDay && parentCompletionDay < scheduledDay &&
      (!checkedInDay || checkedInDay < scheduledDay)) {
      return "NOT_ARRIVED";
    }
    return candidate.status;
  };
}
