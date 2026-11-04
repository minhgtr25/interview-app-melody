import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { DisplayCall, DisplaySettings, InterviewTable } from "@/lib/types";
import { WaitingDisplay } from "./waiting-display";

export const dynamic = "force-dynamic";

export default async function DisplayPage() {
  await requireRole(["COORDINATOR", "ADMIN"]);
  const supabase = await createClient();
  const [calls, settings, tables] = await Promise.all([
    fetchAll<DisplayCall>(supabase, "display_calls", "called_at"),
    fetchAll<DisplaySettings>(supabase, "display_settings", "id"),
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
  ]);
  return <WaitingDisplay initialCalls={calls} initialSettings={settings} initialTables={tables} />;
}
