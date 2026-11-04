import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, DisplaySettings, InterviewTable, Room } from "@/lib/types";
import { ClockProvider } from "@/components/clock";
import { CoordinatorBoard } from "./coordinator-board";

export const dynamic = "force-dynamic";

export default async function CoordinatorPage() {
  const profile = await requireRole(["COORDINATOR", "ADMIN"]);
  const supabase = await createClient();
  const [candidates, tables, rooms, displaySettings] = await Promise.all([
    fetchAll<Candidate>(supabase, "candidates"),
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    fetchAll<DisplaySettings>(supabase, "display_settings", "id"),
  ]);
  return (
    <ClockProvider>
      <CoordinatorBoard
        initialCandidates={candidates}
        initialTables={tables}
        rooms={rooms}
        initialDisplaySettings={displaySettings}
        staffName={profile.full_name || profile.email}
        selfId={profile.id}
      />
    </ClockProvider>
  );
}
