import "server-only";

import { cookies } from "next/headers";
import type { DepartmentCode } from "@/lib/departments";
import { createServiceClient } from "@/lib/supabase/server";
import type { Candidate, Evaluation, ReviewDecision, ReviewPortal, RubricCriterion } from "@/lib/types";
import { verifyReviewSession } from "./crypto";

export const reviewCookieName = (department: DepartmentCode) => `review_session_${department}`;

function reviewSecret() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Thiếu SUPABASE_SERVICE_ROLE_KEY");
  return secret;
}

export async function getReviewPortal(department: DepartmentCode): Promise<ReviewPortal | null> {
  const { data, error } = await createServiceClient().from("review_portals").select("department,active,generation,opened_at,closed_at")
    .eq("department", department).maybeSingle();
  if (error) throw error;
  return (data as ReviewPortal | null) ?? null;
}

export async function hasReviewAccess(department: DepartmentCode, portal: ReviewPortal | null) {
  if (!portal?.active) return false;
  const cookie = (await cookies()).get(reviewCookieName(department))?.value;
  const session = verifyReviewSession(cookie, reviewSecret());
  return session?.department === department && session.generation === portal.generation;
}

export type ReviewCandidate = Pick<Candidate, "id" | "code" | "full_name" | "department" | "shift" | "interview_ended_at"> & {
  evaluation: Evaluation | null;
  decision: ReviewDecision | null;
};

type CompletedCandidate = Pick<Candidate, "id" | "code" | "full_name" | "department" | "shift" | "interview_ended_at">;

export async function getDepartmentReviewData(department: DepartmentCode) {
  const admin = createServiceClient();
  const candidates: CompletedCandidate[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("candidates").select("id,code,full_name,department,shift,interview_ended_at")
      .eq("department", department).eq("status", "COMPLETED")
      .order("code").range(from, from + 999);
    if (error) throw error;
    candidates.push(...((data ?? []) as CompletedCandidate[]));
    if (!data || data.length < 1000) break;
  }
  const { data: criteria, error: criteriaError } = await admin.from("rubric_criteria").select("*").order("sort_order");
  if (criteriaError) throw criteriaError;
  const evaluations: Evaluation[] = [];
  const decisions: ReviewDecision[] = [];
  for (let index = 0; index < candidates.length; index += 100) {
    const ids = candidates.slice(index, index + 100).map((candidate) => candidate.id);
    const [evalResult, decisionResult] = await Promise.all([
      admin.from("evaluations").select("*").in("candidate_id", ids),
      admin.from("review_decisions").select("*").in("candidate_id", ids),
    ]);
    if (evalResult.error) throw evalResult.error;
    if (decisionResult.error) throw decisionResult.error;
    evaluations.push(...((evalResult.data ?? []) as Evaluation[]));
    decisions.push(...((decisionResult.data ?? []) as ReviewDecision[]));
  }
  const evaluationById = new Map(evaluations.map((item) => [item.candidate_id, item]));
  const decisionById = new Map(decisions.map((item) => [item.candidate_id, item]));
  return {
    rows: candidates.map((candidate) => ({ ...candidate, evaluation: evaluationById.get(candidate.id) ?? null,
      decision: decisionById.get(candidate.id) ?? null })) as ReviewCandidate[],
    criteria: (criteria ?? []) as RubricCriterion[],
  };
}
