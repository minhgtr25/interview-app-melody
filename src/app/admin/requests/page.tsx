import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, Profile, ScheduleRequest } from "@/lib/types";
import { RequestsManager } from "./requests-manager";
import { ClockProvider } from "@/components/clock";

export default async function RequestsPage() {
  const client = await createClient();
  const [requests, candidates, profiles] = await Promise.all([
    fetchAll<ScheduleRequest>(client, "schedule_requests"),
    fetchAll<Candidate>(client, "candidates"),
    fetchAll<Profile>(client, "profiles"),
  ]);
  return <ClockProvider><RequestsManager initialRequests={requests} candidates={candidates} profiles={profiles} /></ClockProvider>;
}
