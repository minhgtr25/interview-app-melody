import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { Candidate, InterviewTable, Profile, Room } from "@/lib/types";
import { interviewDays, todayInVietnam } from "@/lib/interview-days";
import { RoomsManager } from "./rooms-manager";
import { DayRoomPlanner, type InterviewDayPlan } from "./day-room-planner";

export default async function AdminRoomsPage() {
  const supabase = await createClient();
  await supabase.rpc("ensure_interview_day");
  const [rooms, tables, profiles, candidates, stateResult, planResult, eventDayResult] = await Promise.all([
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Profile>(supabase, "profiles"),
    fetchAll<Candidate>(supabase, "candidates"),
    supabase.from("interview_day_state").select("day").eq("id", "main").maybeSingle(),
    supabase.from("interview_day_plans").select("day,rooms").order("day"),
    supabase.from("event_interview_days").select("day").order("day"),
  ]);
  const scheduleDays = [...new Set([...interviewDays(candidates), ...(eventDayResult.data ?? []).map((row) => row.day)])];
  return <div className="space-y-6">
    <DayRoomPlanner rooms={rooms} tables={tables} activeDay={stateResult.data?.day ?? todayInVietnam()}
      plans={(planResult.data ?? []) as InterviewDayPlan[]} scheduleDays={scheduleDays} />
    <RoomsManager rooms={rooms} tables={tables} profiles={profiles} activeDay={stateResult.data?.day ?? todayInVietnam()} />
  </div>;
}
