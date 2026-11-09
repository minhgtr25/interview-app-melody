import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, Evaluation, InterviewTable, Room, RubricCriterion } from "@/lib/types";
import { ClockProvider } from "@/components/clock";
import { InterviewerBoard } from "@/app/interviewer/interviewer-board";

export const dynamic = "force-dynamic";

export default async function AdminDeskPreviewPage({ params }: { params: Promise<{ tableId: string }> }) {
  const profile = await requireRole(["ADMIN"]);
  const { tableId } = await params;
  const supabase = await createClient();
  await supabase.rpc("ensure_interview_day");
  const [tables, candidates, rooms, rubric, evaluations, dayState] = await Promise.all([
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Candidate>(supabase, "candidates"),
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    fetchAll<RubricCriterion>(supabase, "rubric_criteria", "sort_order"),
    fetchAll<Evaluation>(supabase, "evaluations"),
    supabase.from("interview_day_state").select("day").eq("id", "main").maybeSingle(),
  ]);
  if (!tables.some((table) => table.id === tableId)) notFound();

  return <ClockProvider>
    <InterviewerBoard
      tableId={tableId}
      initialTables={tables}
      initialCandidates={candidates}
      initialEvaluations={evaluations}
      rooms={rooms}
      rubric={rubric.filter((criterion) => criterion.active)}
      interviewerName={`Admin preview · ${profile.full_name || profile.email}`}
      selfId={profile.id}
      activeDay={dayState.data?.day ?? null}
      adminPreview
    />
  </ClockProvider>;
}
