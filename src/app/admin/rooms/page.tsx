import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { InterviewTable, Profile, Room } from "@/lib/types";
import { todayInVietnam } from "@/lib/interview-days";
import { RoomsManager } from "./rooms-manager";
import { DayRoomPlanner, type InterviewDayPlan } from "./day-room-planner";

export default async function AdminRoomsPage() {
  const supabase = await createClient();
  await supabase.rpc("ensure_interview_day");
  const [rooms, tables, profiles, stateResult, planResult] = await Promise.all([
    fetchAll<Room>(supabase, "rooms", "sort_order"),
    fetchAll<InterviewTable>(supabase, "tables", "sort_order"),
    fetchAll<Profile>(supabase, "profiles"),
    supabase.from("interview_day_state").select("day").eq("id", "main").maybeSingle(),
    supabase.from("interview_day_plans").select("day,rooms").order("day"),
  ]);
  return <div className="space-y-6">
    <div className="border-b pb-5">
      <h1 className="text-2xl font-semibold tracking-tight">Phòng & bàn</h1>
      <p className="mt-1 text-sm text-muted-foreground">Xem cấu hình ngày cũ và tạo phòng, bàn mới cho hôm nay.</p>
    </div>
    <DayRoomPlanner rooms={rooms} tables={tables} activeDay={stateResult.data?.day ?? todayInVietnam()}
      plans={(planResult.data ?? []) as InterviewDayPlan[]} />
    <RoomsManager rooms={rooms} tables={tables} profiles={profiles} activeDay={stateResult.data?.day ?? todayInVietnam()} />
  </div>;
}
