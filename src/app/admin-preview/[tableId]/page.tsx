import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, DebateJudgeReview, Evaluation, InterviewTable, Profile, Room, RubricCriterion } from "@/lib/types";
import { ClockProvider } from "@/components/clock";
import { InterviewerBoard } from "@/app/interviewer/interviewer-board";

export const dynamic = "force-dynamic";

export default async function AdminDeskPreviewPage({ params, searchParams }: {
  params: Promise<{ tableId: string }>;
  searchParams: Promise<{ judgeId?: string }>;
}) {
  const profile = await requireRole(["ADMIN"]);
  const { tableId } = await params;
  const supabase = await createClient();
  await supabase.rpc("ensure_interview_day");
  const [tables, candidates, rooms, rubric, evaluations, debateReviews, profiles, judgeCount, dayState] = await Promise.all([
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Candidate>(supabase, "candidates"),
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    fetchAll<RubricCriterion>(supabase, "rubric_criteria", "sort_order"),
    fetchAll<Evaluation>(supabase, "evaluations"),
    fetchAll<DebateJudgeReview>(supabase, "debate_judge_reviews", "updated_at"),
    fetchAll<Profile>(supabase, "profiles"),
    supabase.rpc("debate_judge_count", { p_table_id: tableId }),
    supabase.from("interview_day_state").select("day").eq("id", "main").maybeSingle(),
  ]);
  const table = tables.find((item) => item.id === tableId);
  if (!table) notFound();
  const isDebate = rooms.some((room) => room.id === table.room_id && room.is_challenge);
  const previewJudges = isDebate ? profiles.filter((judge) => judge.table_id === tableId && judge.role === "INTERVIEWER" && judge.is_debate_judge)
    .sort((a, b) => (a.debate_judge_position ?? 0) - (b.debate_judge_position ?? 0)) : [];
  const { judgeId } = await searchParams;
  const selectedJudge = isDebate ? previewJudges.find((judge) => judge.id === judgeId) ?? (!judgeId ? previewJudges[0] : undefined) : undefined;
  if (isDebate && !selectedJudge) notFound();

  return <ClockProvider>
    <InterviewerBoard
      tableId={tableId}
      initialTables={tables}
      initialCandidates={candidates}
      initialEvaluations={evaluations}
      initialDebateReviews={debateReviews}
      debateJudgePosition={selectedJudge?.debate_judge_position ?? null}
      debateJudgeCount={Number(judgeCount.data ?? 1)}
      rooms={rooms}
      rubric={rubric.filter((criterion) => criterion.active)}
      interviewerName={selectedJudge ? `Admin · ${selectedJudge.full_name || selectedJudge.email} · Giám khảo ${selectedJudge.debate_judge_position}` : `Admin preview · ${profile.full_name || profile.email}`}
      selfId={profile.id}
      actingJudgeId={selectedJudge?.id}
      previewJudges={previewJudges}
      activeDay={dayState.data?.day ?? null}
      adminPreview
    />
  </ClockProvider>;
}
