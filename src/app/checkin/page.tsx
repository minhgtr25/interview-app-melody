import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate } from "@/lib/types";
import { CheckinBoard } from "./checkin-board";

export const dynamic = "force-dynamic";

export default async function CheckinPage() {
  const profile = await requireRole(["CHECKIN", "ADMIN", "COORDINATOR"]);
  const supabase = await createClient();
  const candidates = await fetchAll<Candidate>(supabase, "candidates");
  return <CheckinBoard initialCandidates={candidates} staffName={profile.full_name || profile.email} />;
}
