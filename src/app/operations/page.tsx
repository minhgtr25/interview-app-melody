import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, Evaluation, InterviewTable, Room, RubricCriterion } from "@/lib/types";
import { OperationsBoard } from "./operations-board";

export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const profile = await requireRole(["ADMIN", "COORDINATOR"]);
  const supabase = await createClient();
  const [candidates, evaluations, tables, rooms, criteria] = await Promise.all([
    fetchAll<Candidate>(supabase, "candidates"),
    fetchAll<Evaluation>(supabase, "evaluations"),
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    fetchAll<RubricCriterion>(supabase, "rubric_criteria", "sort_order"),
  ]);
  return <OperationsBoard
    role={profile.role as "ADMIN" | "SUPPORT_IT" | "COORDINATOR"}
    staffName={profile.full_name || profile.email}
    initialCandidates={candidates}
    initialEvaluations={evaluations}
    initialTables={tables}
    initialRooms={rooms}
    criteria={criteria}
  />;
}
