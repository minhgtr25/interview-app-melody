"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarDays, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { dayLabel, todayInVietnam } from "@/lib/interview-days";
import { DEPARTMENTS, type DepartmentCode } from "@/lib/departments";
import { SPECIALIZATIONS_BY_DEPARTMENT, isSpecializedDepartment, type SpecializationCode } from "@/lib/specializations";
import { errorMessage } from "@/lib/format";
import type { InterviewTable, Room } from "@/lib/types";

export type PlannedTable = { id: string; department: DepartmentCode | null; specialization: SpecializationCode | null; sort_order: number };
export type PlannedRoom = { id: string; is_configured: boolean; is_challenge: boolean; external_challenge: boolean; sort_order: number; tables: PlannedTable[] };
export type InterviewDayPlan = { day: string; rooms: PlannedRoom[] };

function physicalPlan(rooms: Room[], tables: InterviewTable[]): PlannedRoom[] {
  return rooms.map((room) => ({
    id: room.id,
    is_configured: room.is_configured,
    is_challenge: room.is_challenge,
    external_challenge: room.external_challenge,
    sort_order: room.sort_order,
    tables: tables.filter((table) => table.room_id === room.id).map((table) => ({
      id: table.id, department: table.department, specialization: table.specialization, sort_order: table.sort_order,
    })),
  }));
}

export function DayRoomPlanner({ rooms, tables, activeDay, plans, scheduleDays }: {
  rooms: Room[];
  tables: InterviewTable[];
  activeDay: string;
  plans: InterviewDayPlan[];
  scheduleDays: string[];
}) {
  const router = useRouter();
  const today = todayInVietnam();
  const allDays = useMemo(() => [...new Set([...scheduleDays, ...plans.map((plan) => plan.day), activeDay, today])].sort(), [scheduleDays, plans, activeDay, today]);
  const [selectedDay, setSelectedDay] = useState(() => allDays.find((day) => day > activeDay) ?? activeDay);
  const [savedPlans, setSavedPlans] = useState(plans);
  const current = useMemo(() => physicalPlan(rooms, tables), [rooms, tables]);
  const initialFor = (day: string) => {
    if (day === activeDay) return current;
    const planned = savedPlans.find((plan) => plan.day === day)?.rooms;
    if (day < activeDay) return planned ?? [];
    return current.map((physical) => {
      const saved = planned?.find((room) => room.id === physical.id);
      if (!saved) return { ...physical, is_configured: !planned && physical.is_configured };
      return { ...saved, tables: physical.tables.map((table) => saved.tables.find((item) => item.id === table.id) ?? table) };
    });
  };
  const [draft, setDraft] = useState<PlannedRoom[]>(() => structuredClone(initialFor(selectedDay)));
  const [busy, setBusy] = useState(false);
  const roomById = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);
  const isFuture = selectedDay > activeDay;
  const isSaved = savedPlans.some((plan) => plan.day === selectedDay);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initialFor(selectedDay));

  useEffect(() => {
    setSavedPlans(plans);
    if (selectedDay === activeDay) setDraft(structuredClone(physicalPlan(rooms, tables)));
  }, [plans, rooms, tables, activeDay, selectedDay]);

  function chooseDay(day: string) {
    setSelectedDay(day);
    setDraft(structuredClone(initialFor(day)));
  }
  function changeRoom(id: string, patch: Partial<PlannedRoom>) {
    setDraft((current) => current.map((room) => room.id === id ? { ...room, ...patch } : room));
  }
  function changeTable(roomId: string, tableId: string, patch: Partial<PlannedTable>) {
    setDraft((current) => current.map((room) => room.id === roomId ? {
      ...room,
      tables: room.tables.map((table) => table.id === tableId ? { ...table, ...patch } : table),
      is_challenge: room.is_challenge && room.tables.every((table) => (table.id === tableId ? patch.department ?? table.department : table.department) === "HCTC"),
      external_challenge: room.external_challenge && room.tables.every((table) => (table.id === tableId ? patch.department ?? table.department : table.department) === "VH"),
    } : room));
  }
  async function savePlan() {
    setBusy(true);
    const { error } = await createClient().rpc("save_interview_day_plan", { p_day: selectedDay, p_rooms: draft });
    setBusy(false);
    if (error) return toast.error(error.code === "PGRST202" ? "Chạy migration 20261120_interview_day_rooms.sql trước khi lập lịch phòng." : errorMessage(error));
    setSavedPlans((current) => [...current.filter((plan) => plan.day !== selectedDay), { day: selectedDay, rooms: structuredClone(draft) }]);
    toast.success(`Đã lưu bố trí phòng ngày ${dayLabel(selectedDay)}`);
    router.refresh();
  }
  async function activateDay() {
    setBusy(true);
    const { error } = await createClient().rpc("activate_interview_day", { p_day: selectedDay });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success(`Đã kích hoạt phòng và bàn ngày ${dayLabel(selectedDay)}`);
    router.refresh();
  }

  return <section className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center gap-3">
      <CalendarDays className="size-5" />
      <div className="mr-auto"><h2 className="font-semibold">Bố trí phòng theo ngày</h2><p className="text-sm text-muted-foreground">Ngày đang hoạt động: {dayLabel(activeDay)}. Tài khoản Giám khảo gắn với bàn và được giữ khi đổi Ban.</p></div>
      <select className="h-9 rounded-lg border border-input bg-background px-3 text-sm" value={selectedDay} onChange={(event) => chooseDay(event.target.value)} aria-label="Chọn ngày bố trí phòng">
        {allDays.map((day) => <option key={day} value={day}>{dayLabel(day)}{day === activeDay ? " · đang hoạt động" : ""}</option>)}
      </select>
    </div>
    {selectedDay < activeDay && !isSaved && <p className="rounded-lg bg-muted p-3 text-sm">Không có bản chụp cấu hình phòng cho ngày này. Các phiếu chấm cũ vẫn giữ tên phòng và bàn đã ghi khi phỏng vấn.</p>}
    {selectedDay === activeDay && <p className="rounded-lg bg-muted p-3 text-sm">Bố trí ngày đang hoạt động được chỉnh tại phần cấu hình phòng và bàn bên dưới.</p>}
    {isFuture && <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900 dark:bg-blue-950/30 dark:text-blue-100">Chỉnh ngày sau ở đây không đổi phòng/bàn đang hoạt động. Sau khi mọi bàn trống và sang đúng ngày, bấm “Kích hoạt ngày” để áp dụng.</p>}
    {draft.length > 0 && <div className="grid gap-3 xl:grid-cols-2">
      {[...draft].sort((a, b) => a.sort_order - b.sort_order).map((room) => <div key={room.id} className="space-y-3 rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="mr-auto font-semibold">{roomById.get(room.id)?.name ?? "Phòng đã xóa"}</h3>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={room.is_configured} disabled={!isFuture || busy} onChange={(event) => changeRoom(room.id, { is_configured: event.target.checked })} />Dùng ngày này</label>
          <label className="flex items-center gap-1 text-sm">Thứ tự <Input type="number" className="h-8 w-16" value={room.sort_order} disabled={!isFuture || busy} onChange={(event) => changeRoom(room.id, { sort_order: Number(event.target.value) })} /></label>
        </div>
        {room.is_configured && <>
          <label className="grid gap-1 text-sm">Chế độ phòng
            <select className="h-9 rounded-lg border border-input bg-background px-2" disabled={!isFuture || busy} value={room.is_challenge ? "DEBATE" : room.external_challenge ? "EXTERNAL" : "NORMAL"}
              onChange={(event) => changeRoom(room.id, { is_challenge: event.target.value === "DEBATE", external_challenge: event.target.value === "EXTERNAL" })}>
              <option value="NORMAL">Phỏng vấn thường</option>
              {room.tables.length > 0 && room.tables.every((table) => table.department === "HCTC") && <option value="DEBATE">HCTC · Debate</option>}
              {room.tables.length > 0 && room.tables.every((table) => table.department === "VH") && <option value="EXTERNAL">Văn hoá · Thử thách ngoài phòng</option>}
            </select>
          </label>
          <div className="grid gap-2 sm:grid-cols-2">{[...room.tables].sort((a, b) => a.sort_order - b.sort_order).map((table) => <div key={table.id} className="space-y-2 rounded-lg bg-muted/50 p-2 text-sm">
            <div className="flex items-center gap-2"><span className="mr-auto font-medium">{tables.find((item) => item.id === table.id)?.name ?? "Bàn"}</span><label className="flex items-center gap-1">Thứ tự <Input type="number" className="h-8 w-14" value={table.sort_order} disabled={!isFuture || busy} onChange={(event) => changeTable(room.id, table.id, { sort_order: Number(event.target.value) })} /></label></div>
            <select className="h-9 w-full rounded-lg border border-input bg-background px-2" value={table.department ?? ""} disabled={!isFuture || busy}
              onChange={(event) => changeTable(room.id, table.id, { department: event.target.value as DepartmentCode, specialization: null })} aria-label="Ban phụ trách bàn">
              <option value="">Chọn Ban</option>{DEPARTMENTS.map((department) => <option key={department.code} value={department.code}>{department.name}</option>)}
            </select>
            {isSpecializedDepartment(table.department) && <select className="h-9 w-full rounded-lg border border-input bg-background px-2" value={table.specialization ?? ""} disabled={!isFuture || busy}
              onChange={(event) => changeTable(room.id, table.id, { specialization: event.target.value as SpecializationCode })} aria-label="Ngạch phụ trách bàn">
              <option value="">Chọn ngạch</option>{(table.department === "CM" ? SPECIALIZATIONS_BY_DEPARTMENT.CM : SPECIALIZATIONS_BY_DEPARTMENT.TT).map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
            </select>}
          </div>)}</div>
        </>}
      </div>)}
    </div>}
    {isFuture && <div className="flex flex-wrap gap-2">
      <Button onClick={() => void savePlan()} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Lưu bố trí ngày {dayLabel(selectedDay)}</Button>
      {selectedDay === today && <Button variant="outline" onClick={() => void activateDay()} disabled={busy || !isSaved || isDirty} title={isDirty ? "Lưu thay đổi trước khi kích hoạt" : undefined}>Kích hoạt ngày {dayLabel(selectedDay)}</Button>}
    </div>}
  </section>;
}
