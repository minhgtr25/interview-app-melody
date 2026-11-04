import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, InterviewTable, Room, RubricCriterion } from "@/lib/types";
import { ClockProvider } from "@/components/clock";
import { AppHeader } from "@/components/app-header";
import { InterviewerBoard } from "./interviewer-board";

export const dynamic = "force-dynamic";

export default async function InterviewerPage() {
  const profile = await requireRole(["INTERVIEWER"]);
  const name = profile.full_name || profile.email;

  if (!profile.table_id) {
    return (
      <div className="min-h-dvh bg-muted/30">
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

  const supabase = await createClient();
  const [tables, candidates, rooms, rubric] = await Promise.all([
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Candidate>(supabase, "candidates"),
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    fetchAll<RubricCriterion>(supabase, "rubric_criteria", "sort_order"),
  ]);

  return (
    <ClockProvider>
      <InterviewerBoard
        tableId={profile.table_id}
        initialTables={tables}
        initialCandidates={candidates}
        rooms={rooms}
        rubric={rubric.filter((r) => r.active)}
        interviewerName={name}
        selfId={profile.id}
      />
    </ClockProvider>
  );
}
