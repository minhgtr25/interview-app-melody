import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate } from "@/lib/types";
import { ClockProvider } from "@/components/clock";
import { CheckinBoard } from "./checkin-board";

export const dynamic = "force-dynamic";

export default async function CheckinPage() {
  const profile = await requireRole(["CHECKIN", "ADMIN", "COORDINATOR"]);
  const supabase = await createClient();
  await supabase.rpc("ensure_interview_day");
  await supabase.rpc("activate_due_followups");
  const [candidates, dayState] = await Promise.all([
    fetchAll<Candidate>(supabase, "candidates"),
    supabase.from("interview_day_state").select("day").eq("id", "main").maybeSingle(),
  ]);
  return <ClockProvider><CheckinBoard initialCandidates={candidates} activeDay={dayState.data?.day} staffName={profile.full_name || profile.email} /></ClockProvider>;
}
