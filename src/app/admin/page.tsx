import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, InterviewTable, Room } from "@/lib/types";
import { ClockProvider } from "@/components/clock";
import { Dashboard } from "./dashboard";

export default async function AdminDashboardPage() {
  const supabase = await createClient();
  await supabase.rpc("ensure_interview_day");
  const [candidates, tables, rooms] = await Promise.all([
    fetchAll<Candidate>(supabase, "candidates"),
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Room>(supabase, "rooms", "sort_order"),
  ]);
  return (
    <ClockProvider>
      <Dashboard initialCandidates={candidates} initialTables={tables} rooms={rooms} />
    </ClockProvider>
  );
}
