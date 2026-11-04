import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { RubricCriterion } from "@/lib/types";
import { RubricManager } from "./rubric-manager";

export default async function AdminRubricPage() {
  const supabase = await createClient();
  const criteria = await fetchAll<RubricCriterion>(supabase, "rubric_criteria", "sort_order");
  const { count } = await supabase.from("evaluations").select("id", { count: "exact", head: true });
  return <RubricManager criteria={criteria} evaluationCount={count ?? 0} />;
}
