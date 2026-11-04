import { requireRole } from "@/lib/auth";
import { fetchAll } from "@/lib/fetch-all";
import { createServiceClient } from "@/lib/supabase/server";
import type { Candidate, Evaluation, ReviewDecision, ReviewDecisionEvent, ReviewPortal } from "@/lib/types";
import { ReviewManagement } from "./review-management";

export const dynamic = "force-dynamic";

export default async function AdminReviewsPage() {
  await requireRole(["ADMIN"]);
  const admin = createServiceClient();
  const [portalResult, candidates, evaluations, decisions, eventsResult] = await Promise.all([
    admin.from("review_portals").select("department,active,generation,opened_at,closed_at"),
    fetchAll<Candidate>(admin, "candidates"),
    fetchAll<Evaluation>(admin, "evaluations"),
    fetchAll<ReviewDecision>(admin, "review_decisions", "updated_at"),
    admin.from("review_decision_events").select("*").order("changed_at", { ascending: false }).limit(20),
  ]);
  if (portalResult.error) throw portalResult.error;
  if (eventsResult.error) throw eventsResult.error;
  return <ReviewManagement
    portals={(portalResult.data ?? []) as ReviewPortal[]}
    candidates={candidates}
    evaluations={evaluations}
    decisions={decisions}
    events={(eventsResult.data ?? []) as ReviewDecisionEvent[]}
  />;
}
