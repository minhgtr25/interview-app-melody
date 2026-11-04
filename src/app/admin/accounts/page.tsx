import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { InterviewTable, Profile, Room } from "@/lib/types";
import { AccountsManager } from "./accounts-manager";

export default async function AdminAccountsPage() {
  const supabase = await createClient();
  const [profiles, tables, rooms, session] = await Promise.all([
    fetchAll<Profile>(supabase, "profiles"),
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    getSessionProfile(),
  ]);
  return (
    <AccountsManager
      profiles={profiles}
      tables={tables}
      rooms={rooms}
      currentUserId={session?.userId ?? ""}
      serviceKeyConfigured={!!process.env.SUPABASE_SERVICE_ROLE_KEY}
    />
  );
}
