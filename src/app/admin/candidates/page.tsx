import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, Evaluation } from "@/lib/types";
import { CandidatesManager } from "./candidates-manager";

export default async function AdminCandidatesPage() {
  const supabase = await createClient();
  const [candidates, evaluations] = await Promise.all([
    fetchAll<Candidate>(supabase, "candidates"),
    fetchAll<Evaluation>(supabase, "evaluations"),
  ]);
  return <CandidatesManager initialCandidates={candidates} initialEvaluations={evaluations} />;
}
