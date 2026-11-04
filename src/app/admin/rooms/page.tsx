import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { InterviewTable, Profile, Room } from "@/lib/types";
import { RoomsManager } from "./rooms-manager";

export default async function AdminRoomsPage() {
  const supabase = await createClient();
  const [rooms, tables, profiles] = await Promise.all([
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Profile>(supabase, "profiles"),
  ]);
  return <RoomsManager rooms={rooms} tables={tables} profiles={profiles} />;
}
