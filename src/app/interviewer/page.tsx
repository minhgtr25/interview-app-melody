import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, DebateJudgeReview, Evaluation, InterviewTable, Room, RubricCriterion } from "@/lib/types";
import { ClockProvider } from "@/components/clock";
import { AppHeader } from "@/components/app-header";
import { InterviewerBoard } from "./interviewer-board";

export const dynamic = "force-dynamic";

export default async function InterviewerPage() {
  const supabase = await createClient();
  await supabase.rpc("ensure_interview_day");
  const profile = await requireRole(["INTERVIEWER"]);
  const name = profile.full_name || profile.email;

  if (!profile.table_id) {
    return (
      <div className="min-h-dvh bg-background">
        <AppHeader title="Giám khảo" subtitle={name} />
        <main className="mx-auto max-w-md px-4 py-16 text-center">
          <p className="text-lg font-semibold">Bạn chưa được phân bàn</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Liên hệ Admin để được gán vào một bàn phỏng vấn, sau đó tải lại trang.
          </p>
        </main>
      </div>
    );
  }

  const [tables, candidates, rooms, rubric, evaluations, debateReviews, judgeCount, dayState] = await Promise.all([
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Candidate>(supabase, "candidates"),
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    fetchAll<RubricCriterion>(supabase, "rubric_criteria", "sort_order"),
    fetchAll<Evaluation>(supabase, "evaluations"),
    fetchAll<DebateJudgeReview>(supabase, "debate_judge_reviews", "updated_at"),
    supabase.rpc("debate_judge_count", { p_table_id: profile.table_id }),
    supabase.from("interview_day_state").select("day").eq("id", "main").maybeSingle(),
  ]);

  return (
    <ClockProvider>
      <InterviewerBoard
        tableId={profile.table_id}
        initialTables={tables}
        initialCandidates={candidates}
        initialEvaluations={evaluations}
        initialDebateReviews={debateReviews}
        debateJudgePosition={profile.debate_judge_position}
        debateJudgeCount={Number(judgeCount.data ?? 1)}
        rooms={rooms}
        rubric={rubric.filter((r) => r.active)}
        interviewerName={profile.is_debate_judge ? `${name} · Giám khảo Debate ${profile.debate_judge_position === 1 ? "1 (chính)" : "2 (phụ)"}` : name}
        selfId={profile.id}
        activeDay={dayState.data?.day ?? null}
      />
    </ClockProvider>
  );
}
