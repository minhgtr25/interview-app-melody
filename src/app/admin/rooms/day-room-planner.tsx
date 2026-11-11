"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { createClient } from "@/lib/supabase/client";
import { dayLabel, todayInVietnam } from "@/lib/interview-days";
import { errorMessage } from "@/lib/format";
import type { InterviewTable, Room } from "@/lib/types";
import { useServerNow } from "@/components/clock";

export type PlannedTable = {
  id: string;
  name?: string;
  department: string | null;
  specialization: string | null;
  sort_order: number;
  judges?: Array<{ id: string; name: string; email: string; position: number | null }>;
};
export type PlannedRoom = {
  id: string;
  name?: string;
  is_configured: boolean;
  is_challenge: boolean;
  external_challenge: boolean;
  sort_order: number;
  tables: PlannedTable[];
};
export type InterviewDayPlan = { day: string; rooms: PlannedRoom[] };

export function DayRoomPlanner({ rooms, tables, activeDay, plans }: {
  rooms: Room[];
  tables: InterviewTable[];
  activeDay: string;
  plans: InterviewDayPlan[];
}) {
  const router = useRouter();
  const now = useServerNow(30_000);
  const today = todayInVietnam(now);
  const [selectedDay, setSelectedDay] = useState(activeDay);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSelectedDay(activeDay), [activeDay]);
  const days = useMemo(() => [...new Set([activeDay, ...plans.filter((plan) => plan.day <= activeDay).map((plan) => plan.day)])].sort().reverse(),
    [activeDay, plans]);
  const savedToday = plans.find((plan) => plan.day === activeDay && plan.rooms.length > 0);
  const currentRooms = useMemo<PlannedRoom[]>(() => rooms.map((room) => ({
    id: room.id, name: room.name, is_configured: room.is_configured,
    is_challenge: room.is_challenge, external_challenge: room.external_challenge,
    sort_order: room.sort_order,
    tables: tables.filter((table) => table.room_id === room.id).map((table) => ({
      id: table.id, name: table.name, department: table.department,
      specialization: table.specialization, sort_order: table.sort_order,
    })),
  })), [rooms, tables]);
  const shown = selectedDay === activeDay ? currentRooms
    : selectedDay === `${activeDay}:saved` ? savedToday?.rooms ?? []
      : plans.find((plan) => plan.day === selectedDay)?.rooms ?? [];

  async function retryRollover() {
    setBusy(true);
    const { error } = await createClient().rpc("activate_interview_day", { p_day: today });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success(`Đã lưu cấu hình cũ và mở ngày ${dayLabel(today)} với danh sách bàn trống`);
    router.refresh();
  }

  async function resetToday() {
    setBusy(true);
    const { error } = await createClient().rpc("reset_today_interview_rooms");
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success("Đã lưu cấu hình hiện tại và dọn toàn bộ phòng/bàn để tạo lại");
    router.refresh();
  }

  return <section className="space-y-4 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center gap-3">
      <CalendarDays className="size-5 text-muted-foreground" />
      <div className="mr-auto">
        <h2 className="font-semibold">Cấu hình theo ngày</h2>
        <p className="text-sm text-muted-foreground">Cấu hình ngày cũ được lưu lại. Ngày mới bắt đầu với danh sách phòng và bàn trống.</p>
      </div>
      <select className="h-9 rounded-lg border border-input bg-background px-3 text-sm" value={selectedDay}
        onChange={(event) => setSelectedDay(event.target.value)} aria-label="Xem cấu hình ngày">
        {days.map((day) => <option key={day} value={day}>{dayLabel(day)}{day === activeDay ? " · đang hoạt động" : " · đã lưu"}</option>)}
        {savedToday && <option value={`${activeDay}:saved`}>Bản lưu trước khi tạo lại · {dayLabel(activeDay)}</option>}
      </select>
    </div>
    {activeDay < today && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p>Chưa chuyển sang ngày {dayLabel(today)}. Hoàn tất các ca còn ở bàn rồi thử lại.</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void retryRollover()}>
        {busy && <Loader2 className="animate-spin" />} Chuyển sang hôm nay
      </Button>
    </div>}
    {selectedDay === activeDay && activeDay === today && currentRooms.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-3 text-sm">
      <p>Muốn tạo lại từ đầu? Cấu hình này sẽ được lưu trước khi dọn phòng và bàn.</p>
      <AlertDialog>
        <AlertDialogTrigger render={<Button size="sm" variant="outline" disabled={busy} />}>Lưu và tạo lại từ đầu</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Đặt lại phòng và bàn hôm nay?</AlertDialogTitle>
            <AlertDialogDescription>
              Hệ thống lưu bản chụp cấu hình hiện tại, ẩn toàn bộ phòng/bàn cũ và tháo tài khoản giám khảo để bạn gán lại. Lịch sử chấm và trao đổi vẫn được giữ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction onClick={() => void resetToday()}>Lưu và đặt lại</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>}
    {shown.length === 0 ? <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
      {selectedDay === activeDay ? "Hôm nay chưa có phòng/bàn. Tạo phòng mới ở phần bên dưới." : "Ngày này chưa có bản chụp cấu hình phòng/bàn."}
    </p> : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[...shown].sort((a, b) => a.sort_order - b.sort_order).map((room) => <div key={room.id} className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{room.name || rooms.find((item) => item.id === room.id)?.name || "Phòng đã lưu"}</h3>
          <span className="text-xs text-muted-foreground">{room.is_configured ? "Đã kích hoạt" : "Chưa kích hoạt"}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{room.is_challenge ? "Debate" : room.external_challenge ? "Thử thách Văn hoá" : "Phỏng vấn thường"}</p>
        <ul className="mt-3 divide-y text-sm">
          {[...room.tables].sort((a, b) => a.sort_order - b.sort_order).map((table) => <li key={table.id} className="flex items-center justify-between gap-2 py-1.5">
            <span>
              <span className="block">{table.name || tables.find((item) => item.id === table.id)?.name || "Bàn đã lưu"}</span>
              {!!table.judges?.length && <span className="block text-xs text-muted-foreground">{table.judges.map((judge) => judge.name || judge.email).join(", ")}</span>}
            </span>
            <span className="text-right text-muted-foreground">{table.department ?? "Chưa chọn ban"}{table.specialization ? ` · ${table.specialization}` : ""}</span>
          </li>)}
        </ul>
      </div>)}
    </div>}
  </section>;
}
