import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, InterviewTable, Profile, Room } from "@/lib/types";
import { ClockProvider } from "@/components/clock";
import { CoordinatorBoard } from "./coordinator-board";

export const dynamic = "force-dynamic";

export default async function CoordinatorPage() {
  const profile = await requireRole(["COORDINATOR", "ADMIN"]);
  const supabase = await createClient();
  await supabase.rpc("activate_due_followups");
  const [candidates, tables, rooms, profiles] = await Promise.all([
    fetchAll<Candidate>(supabase, "candidates"),
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    fetchAll<Profile>(supabase, "profiles"),
  ]);
  return (
    <ClockProvider>
      <CoordinatorBoard
        initialCandidates={candidates}
        initialTables={tables}
        rooms={rooms}
        profiles={profiles}
        staffName={profile.full_name || profile.email}
        selfId={profile.id}
        chatIdentity={profile.role === "SUPPORT_IT" ? "support" : "coordinator"}
      />
    </ClockProvider>
  );
}
