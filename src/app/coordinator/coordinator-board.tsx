"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { toast } from "sonner";
import { GripVertical, Loader2, UserX, Undo2, ArrowRightLeft, CircleCheck, Timer, Hourglass, MessageCircle, X, BellRing, Search, ClipboardList, Pause, CalendarClock, RotateCcw, Settings2 } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Elapsed, useServerNow } from "@/components/clock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OpsChat } from "@/components/ops-chat";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useRealtimeRows } from "@/hooks/use-realtime-rows";
import { useOpsChannel } from "@/hooks/use-ops-channel";
import { createClient, prepareRealtime } from "@/lib/supabase/client";
import { errorMessage, normalizeText } from "@/lib/format";
import type { Candidate, DisplaySettings, InterviewTable, OpsMessage, Profile, Room } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DEPARTMENTS } from "@/lib/departments";
import { isSpecializationForDepartment, isSpecializedDepartment, specializationLabel, SPECIALIZATIONS_BY_DEPARTMENT } from "@/lib/specializations";
import type { SpecializationCode } from "@/lib/specializations";
import type { DepartmentCode } from "@/lib/departments";
import { DepartmentRadio } from "@/components/department-radio";
import { groupCandidateApplications } from "@/components/candidate-applications";
import { dayLabel, interviewDate, interviewDays, todayInVietnam } from "@/lib/interview-days";
import { makeInterviewShift } from "@/lib/interview-days";
import { ScheduleFields, isFutureInterviewSlot } from "@/components/schedule-fields";
import { ScheduleRequestDialog } from "@/components/schedule-request-dialog";
import { AbsenceManagerDialog } from "@/components/absence-manager-dialog";
import { useInterviewDayAutoSwitch } from "@/hooks/use-interview-day-auto-switch";

type Confirm =
  | { kind: "release"; table: InterviewTable; candidate?: Candidate }
  | null;

export function CoordinatorBoard({
  initialCandidates,
  initialTables,
  rooms,
  profiles,
  initialDisplaySettings,
  staffName,
  selfId,
  chatIdentity,
  initialDayState,
}: {
  initialCandidates: Candidate[];
  initialTables: InterviewTable[];
  rooms: Room[];
  profiles: Profile[];
  initialDisplaySettings: DisplaySettings[];
  staffName: string;
  selfId: string;
  chatIdentity: "coordinator" | "support";
  initialDayState: { id: string; day: string }[];
}) {
  const cand = useRealtimeRows<Candidate>("candidates", initialCandidates);
  const tbl = useRealtimeRows<InterviewTable>("tables", initialTables, "sort_order");
  const roomRows = useRealtimeRows<Room>("rooms", rooms, "sort_order");
  const profileRows = useRealtimeRows<Profile>("profiles", profiles);
  const displaySettings = useRealtimeRows<DisplaySettings>("display_settings", initialDisplaySettings, "id");
  const dayState = useRealtimeRows<{ id: string; day: string }>("interview_day_state", initialDayState, "day");
  const now = useServerNow(30_000);
  const today = todayInVietnam(now);
  const activeDay = dayState.rows[0]?.day;
  useInterviewDayAutoSwitch(activeDay);
  const dayReady = !activeDay || activeDay === today;
  const previousDay = useRef(today);
  const interviewerTableIds = useMemo(() => new Set(profileRows.rows
    .filter((profile) => profile.role === "INTERVIEWER" && profile.table_id)
    .map((profile) => profile.table_id!)), [profileRows.rows]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dispatchSpecializations, setDispatchSpecializations] = useState<Record<string, SpecializationCode | "">>({});
  const [dragOverTable, setDragOverTable] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [absenceOpen, setAbsenceOpen] = useState(false);
  const [tvConfigOpen, setTvConfigOpen] = useState(false);
  const [tvDepartmentDraft, setTvDepartmentDraft] = useState<DepartmentCode[]>([]);
  const [tvSaving, setTvSaving] = useState(false);
  const [markAbsentCandidate, setMarkAbsentCandidate] = useState<Candidate | null>(null);
  const [markAbsentNote, setMarkAbsentNote] = useState("");
  const [requestCandidate, setRequestCandidate] = useState<Candidate | null>(null);
  const [followupCandidate, setFollowupCandidate] = useState<Candidate | null>(null);
  const [followupDate, setFollowupDate] = useState("");
  const [followupTime, setFollowupTime] = useState("");
  const [tab, setTab] = useState<string>("queue");
  const [queueDepartment, setQueueDepartment] = useState<DepartmentCode | "">("");
  const [queueDay, setQueueDay] = useState(() => interviewDays(initialCandidates).includes(today) ? today : "");
  const [queueSearch, setQueueSearch] = useState("");
  const deferredQueueSearch = normalizeText(useDeferredValue(queueSearch));
  const [chatTableId, setChatTableId] = useState<string | null>(null);
  const [unreadTables, setUnreadTables] = useState<Set<string>>(() => new Set());
  const [alarms, setAlarms] = useState<{ id: string; label: string; body: string; tableId: string; fading: boolean }[]>([]);
  const seenSecondInterviews = useRef<Set<string> | null>(null);
  const tablesRef = useRef(tbl.rows);
  const roomsRef = useRef(roomRows.rows);
  const chatTableIdRef = useRef(chatTableId);

  useEffect(() => {
    if (today === previousDay.current) return;
    const previous = previousDay.current;
    setQueueDay((selected) => selected === previous ? today : selected);
    setSelectedId(null);
    previousDay.current = today;
  }, [today]);
  tablesRef.current = tbl.rows;
  roomsRef.current = roomRows.rows;
  chatTableIdRef.current = chatTableId;

  function openChat(tableId: string) {
    setChatTableId(tableId);
    setUnreadTables((current) => {
      const next = new Set(current);
      next.delete(tableId);
      return next;
    });
  }

  useEffect(() => {
    const client = createClient();
    const timers: number[] = [];
    const seen = new Set<string>();
    const mountedAt = new Date(Date.now() - 2000).toISOString();
    let active = true;
    let channel: RealtimeChannel | null = null;
    const receive = (message: OpsMessage) => {
        if (!active || seen.has(message.id)) return;
        seen.add(message.id);
        if (seen.size > 500) seen.delete(seen.values().next().value!);
        if (message.sender_id === selfId) return;
        const table = tablesRef.current.find((item) => item.id === message.table_id);
        const room = roomsRef.current.find((item) => item.id === table?.room_id);
        const label = `${room?.name ?? "Phòng"} - ${table?.name ?? "Bàn"} (${table?.department ?? "—"})`;
        if (message.kind === "ALARM") {
          try { navigator.vibrate?.([120, 80, 120]); } catch { /* unsupported */ }
          setAlarms((current) => [{ id: message.id, label, body: message.body, tableId: message.table_id, fading: false }, ...current].slice(0, 3));
          timers.push(window.setTimeout(() => setAlarms((current) => current.map((item) => item.id === message.id ? { ...item, fading: true } : item)), 11000));
          timers.push(window.setTimeout(() => setAlarms((current) => current.filter((item) => item.id !== message.id)), 12000));
        } else if (chatTableIdRef.current !== message.table_id) {
          setUnreadTables((current) => new Set(current).add(message.table_id));
          toast.info(`${label} có tin nhắn`, {
            description: message.body, duration: 8000,
            action: { label: "Mở chat", onClick: () => openChat(message.table_id) },
          });
        }
    };
    const catchUp = async () => {
      const { data } = await client.from("ops_messages").select("*")
        .gte("created_at", mountedAt).order("created_at", { ascending: true }).limit(100);
      if (active) for (const message of (data ?? []) as OpsMessage[]) receive(message);
    };
    void prepareRealtime().then(() => {
      if (!active) return;
      channel = client.channel(`coordinator-ops:${Math.random().toString(36).slice(2)}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "ops_messages" },
          (payload: RealtimePostgresChangesPayload<OpsMessage>) => receive(payload.new as OpsMessage))
        .subscribe((status: string) => { if (status === "SUBSCRIBED") void catchUp(); });
    }).catch(() => { /* REST polling still delivers notifications */ });
    void catchUp();
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void catchUp(); }, 4000);
    return () => {
      active = false;
      window.clearInterval(poll);
      timers.forEach((timer) => window.clearTimeout(timer));
      if (channel) void client.removeChannel(channel);
    };
  }, [selfId]);

  useOpsChannel((msg) => {
    if (msg.type !== "CALL_COORDINATOR") return;
    try {
      navigator.vibrate?.([100, 60, 100]);
    } catch {
      /* không hỗ trợ */
    }
    toast.warning(`${msg.tableLabel} gọi điều phối`, {
      description: `${msg.from}: ${msg.reason}`,
      duration: 15000,
    });
  });

  const status = cand.status === "live" && tbl.status === "live" && roomRows.status === "live" && profileRows.status === "live" ? "live" : cand.status === "offline" || tbl.status === "offline" || roomRows.status === "offline" || profileRows.status === "offline" ? "offline" : "connecting";

  const candById = useMemo(() => new Map(cand.rows.map((c) => [c.id, c])), [cand.rows]);
  const groupByCandidate = useMemo(() => {
    const map = new Map<string, ReturnType<typeof groupCandidateApplications>[number]>();
    for (const group of groupCandidateApplications(cand.rows)) {
      for (const application of group.applications) map.set(application.id, group);
    }
    return map;
  }, [cand.rows]);
  const days = useMemo(() => interviewDays(cand.rows), [cand.rows]);

  useEffect(() => {
    const incoming = cand.rows.filter((c) => c.source_candidate_id && c.status === "CHECKED_IN" && !c.challenge_status);
    if (seenSecondInterviews.current) {
      for (const candidate of incoming) if (!seenSecondInterviews.current.has(candidate.id)) {
        toast.info(`Có lượt phỏng vấn Ban ${candidate.department}`, {
          description: `${candidate.full_name} đã vào hàng chờ phỏng vấn Ban ${candidate.department}.`, duration: 12000,
        });
      }
    }
    seenSecondInterviews.current = new Set(incoming.map((c) => c.id));
  }, [cand.rows]);

  const queue = useMemo(
    () =>
      cand.rows
        .filter((c) => c.status === "CHECKED_IN" && !c.challenge_status && (!queueDepartment || c.department === queueDepartment)
          && (!queueDay || interviewDate(c) === queueDay || !interviewDate(c))
          && (!deferredQueueSearch || normalizeText(`${c.full_name} ${c.code} ${c.student_number ?? groupByCandidate.get(c.id)?.primary.student_number ?? ""} ${c.phone ?? ""}`).includes(deferredQueueSearch)))
        .sort((a, b) => (a.checked_in_at ?? "").localeCompare(b.checked_in_at ?? "")),
    [cand.rows, queueDepartment, queueDay, deferredQueueSearch, groupByCandidate]
  );

  const grouped = useMemo(() => {
    const byRoom = new Map<string, InterviewTable[]>();
    for (const t of tbl.rows) {
      const list = byRoom.get(t.room_id) ?? [];
      list.push(t);
      byRoom.set(t.room_id, list);
    }
    for (const list of byRoom.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    const sortedRooms = [...roomRows.rows]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((r) => ({ room: r, tables: byRoom.get(r.id) ?? [] }));
    return [...DEPARTMENTS, { code: "" as const, name: "Chưa chọn Ban" }]
      .map((department) => ({ department, rooms: sortedRooms
        .map(({ room, tables }) => ({ room, tables: tables.filter((table) => (table.department ?? "") === department.code) }))
        .filter(({ tables, room }) => tables.length > 0 || (!department.code && (byRoom.get(room.id) ?? []).length === 0)) }))
      .filter((group) => group.rooms.length > 0);
  }, [tbl.rows, roomRows.rows]);

  const roomById = useMemo(() => new Map(roomRows.rows.map((room) => [room.id, room])), [roomRows.rows]);
  function tableConfigurationIssue(table: InterviewTable): string | null {
    if (!table.department) return "Chưa chọn Ban";
    if (isSpecializedDepartment(table.department) && !isSpecializationForDepartment(table.department, table.specialization)) return "Chưa chọn ngạch hợp lệ";
    if (!isSpecializedDepartment(table.department) && table.specialization) return "Ngạch không áp dụng cho Ban này";
    if (!interviewerTableIds.has(table.id)) return "Chưa gán tài khoản Giám khảo";
    return null;
  }
  const freeCount = dayReady ? tbl.rows.filter((t) => t.status === "AVAILABLE" && !t.is_paused && roomById.get(t.room_id)?.is_configured && !roomById.get(t.room_id)?.is_challenge && !tableConfigurationIssue(t)).length : 0;
  const visibleTvDepartments = displaySettings.rows.find((item) => item.id === "main")?.visible_departments
    ?? DEPARTMENTS.map((department) => department.code);

  function openTvConfig() {
    setTvDepartmentDraft([...visibleTvDepartments]);
    setTvConfigOpen(true);
  }

  function toggleTvDepartment(department: DepartmentCode) {
    setTvDepartmentDraft((current) => current.includes(department)
      ? current.filter((code) => code !== department)
      : DEPARTMENTS.map((item) => item.code).filter((code) => code === department || current.includes(code)));
  }

  async function saveTvConfig() {
    setTvSaving(true);
    const { data, error } = await createClient().from("display_settings")
      .update({ visible_departments: tvDepartmentDraft })
      .eq("id", "main")
      .select("id,visible_departments")
      .single();
    setTvSaving(false);
    if (error || !data) return toast.error(errorMessage(error ?? new Error("Không lưu được cấu hình TV")));
    displaySettings.patchRow("main", { visible_departments: data.visible_departments as DepartmentCode[] });
    setTvConfigOpen(false);
    toast.success("Đã cập nhật các ban hiển thị trên TV");
  }
  const selected = selectedId ? candById.get(selectedId) : undefined;
  // Bỏ chọn nếu thí sinh đã rời hàng chờ (do người khác gán)
  const selectedValid = selected && queue.some((candidate) => candidate.id === selected.id) ? selected : undefined;
  function specializationForDispatch(candidate: Candidate) {
    return dispatchSpecializations[candidate.id] ?? candidate.specialization ?? "";
  }

  async function assign(candidateId: string, table: InterviewTable) {
    if (!dayReady) return toast.error("Chưa thể điều phối: hệ thống đang chờ bố trí phòng ngày hôm nay");
    const c = candById.get(candidateId);
    if (!c || !queue.some((candidate) => candidate.id === c.id)) return toast.error("Thí sinh không còn ở hàng chờ của ngày đã chọn");
    if (c.source_candidate_id && !c.shift) return toast.error("Cần xếp Ca Ban thứ hai trước khi đẩy thí sinh vào bàn");
    if (table.status !== "AVAILABLE") return toast.error("Bàn này đang bận");
    if (table.is_paused) return toast.error("Bàn này đang tạm dừng nhận thí sinh");
    if (roomById.get(table.room_id)?.is_challenge) return toast.error("Bàn thử thách do Giám khảo tự nhận thí sinh");
    if (!roomById.get(table.room_id)?.is_configured) return toast.error("Phòng chưa được kích hoạt");
    const configurationIssue = tableConfigurationIssue(table);
    if (configurationIssue) return toast.error(`Bàn chưa sẵn sàng: ${configurationIssue}`);
    if (!table.department || c.department !== table.department) return toast.error("Ban của thí sinh không khớp Ban phụ trách bàn");
    const specialization = isSpecializedDepartment(c.department) ? specializationForDispatch(c) : "";
    if (isSpecializedDepartment(c.department) && !isSpecializationForDepartment(c.department, specialization))
      return toast.error("Điều phối cần chọn ngạch trước khi đẩy thí sinh vào bàn");
    if (isSpecializedDepartment(c.department) && table.specialization !== specialization)
      return toast.error("Ngạch đã chọn không khớp ngạch phụ trách bàn");
    setBusy(table.id);
    const now = new Date().toISOString();
    cand.patchRow(c.id, { status: "ASSIGNED", table_id: table.id, assigned_at: now, specialization: specialization || null });
    tbl.patchRow(table.id, { status: "ASSIGNED", current_candidate_id: c.id, assigned_at: now });
    const { error } = await createClient().rpc("assign_candidate", {
      p_candidate_id: c.id, p_table_id: table.id, p_specialization: specialization || null,
    });
    setBusy(null);
    if (error) {
      toast.error(errorMessage(error));
      void cand.refetch();
      void tbl.refetch();
      return;
    }
    setSelectedId(null);
    toast.success(`${c.full_name} → ${table.name}`);
  }

  async function doConfirm() {
    if (!confirm) return;
    const action = confirm;
    setConfirm(null);
    setBusy(action.table.id);
    const { error } = await createClient().rpc("return_to_queue", { p_table_id: action.table.id });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    toast.success(`Đã giải phóng ${action.table.name}`);
  }

  async function saveAbsent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!markAbsentCandidate) return;
    const candidate = markAbsentCandidate;
    setBusy(candidate.id);
    const { error } = await createClient().rpc("mark_absent_with_note", { p_candidate_id: candidate.id, p_note: markAbsentNote });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    if (selectedId === candidate.id) setSelectedId(null);
    setMarkAbsentCandidate(null);
    void cand.refetch();
    toast.success(`Đã đánh vắng: ${candidate.full_name}`);
  }

  async function saveFollowup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!followupCandidate?.department || !isFutureInterviewSlot(followupDate, followupTime, now)) return;
    setBusy(followupCandidate.id);
    const { error } = await createClient().rpc("set_followup_schedule", {
      p_candidate_id: followupCandidate.id,
      p_shift: makeInterviewShift(followupDate, followupTime, followupCandidate.department),
    });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    setFollowupCandidate(null);
    void cand.refetch();
    toast.success(followupDate === todayInVietnam(now) ? "Đã xếp Ca hôm nay; thí sinh ở lại hàng chờ" : "Đã chuyển lượt Ban thứ hai sang ngày đã chọn");
  }

  function onTableClick(t: InterviewTable) {
    if (!dayReady) return toast.info("Hệ thống đang khóa bố trí cũ và chờ cấu hình ngày hôm nay");
    if (roomById.get(t.room_id)?.is_challenge) return;
    if (t.is_paused) return toast.info("Bàn này đang tạm dừng tiếp nhận");
    if (t.status !== "AVAILABLE") return;
    if (selectedValid?.source_candidate_id && !selectedValid.shift) return toast.info("Điều chỉnh lịch Ban thứ hai trước khi gán bàn");
    if (!selectedValid) {
      toast.info("Chọn một thí sinh trong hàng chờ trước");
      setTab("queue");
      return;
    }
    const targetRoom = roomById.get(t.room_id);
    if (targetRoom?.is_challenge || !targetRoom?.is_configured || tableConfigurationIssue(t) || !t.department || selectedValid.department !== t.department ||
      (isSpecializedDepartment(selectedValid.department) && (!isSpecializationForDepartment(selectedValid.department, specializationForDispatch(selectedValid)) || t.specialization !== specializationForDispatch(selectedValid)))) return;
    void assign(selectedValid.id, t);
  }

  const queuePanel = (
    <section className="flex min-h-0 flex-col rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-semibold">Hàng chờ</h2>
        <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-800 tabular-nums dark:bg-blue-950 dark:text-blue-200">
          {queue.length}
        </span>
      </div>
      <div className="space-y-2 border-b px-3 py-2">
        <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={queueDay}
          onChange={(event) => { setQueueDay(event.target.value); setSelectedId(null); }} aria-label="Lọc hàng chờ theo ngày phỏng vấn">
          <option value="">Mọi ngày phỏng vấn</option>
          {days.map((day) => <option key={day} value={day}>{dayLabel(day)}</option>)}
        </select>
        <div className="relative"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={queueSearch} onChange={(event) => setQueueSearch(event.target.value)}
            className="pl-9" placeholder="Tìm tên, mã hoặc SĐT thí sinh…" aria-label="Tìm thí sinh trong hàng chờ" />
        </div>
        <DepartmentRadio name="coordinator-queue-department" value={queueDepartment} onChange={setQueueDepartment} allowAll />
        {(queueSearch || queueDay || queueDepartment) && <Button type="button" variant="ghost" size="sm" className="w-full"
          onClick={() => { setQueueSearch(""); setQueueDay(""); setQueueDepartment(""); setSelectedId(null); }}>
          <RotateCcw /> Xóa bộ lọc
        </Button>}
      </div>
      <ol className="flex-1 space-y-2 overflow-y-auto p-3">
        {queue.map((c, i) => {
          const isSel = selectedValid?.id === c.id;
          return (
            <li
              key={c.id}
              draggable={!(c.source_candidate_id && !c.shift)}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", c.id);
                e.dataTransfer.effectAllowed = "move";
                setSelectedId(c.id);
              }}
              onClick={() => {
                setSelectedId(isSel ? null : c.id);
                if (!isSel && window.matchMedia("(max-width: 1023px)").matches) setTab("tables");
              }}
              className={cn(
                "group flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-all select-none hover:border-primary/40",
                isSel && "border-primary bg-primary/5 ring-2 ring-primary/30"
              )}
            >
              <GripVertical className="hidden size-4 shrink-0 text-muted-foreground lg:block" />
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                 <p className="truncate font-medium">{c.full_name} {c.source_candidate_id && !c.shift && <span title="Chưa chốt lịch Ban thứ hai" className="ml-1 inline-flex size-5 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-white">?</span>}</p>
                {(c.source_candidate_id || (groupByCandidate.get(c.id)?.applications?.length ?? 0) > 1) && (
                  <p className="text-xs font-semibold text-violet-700 dark:text-violet-300">Lượt phỏng vấn Ban khác của cùng thí sinh</p>
                )}
                <p className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{c.code}</span>
                  {(c.student_number || groupByCandidate.get(c.id)?.primary.student_number) && <span className="font-mono"> · MSSV {c.student_number || groupByCandidate.get(c.id)?.primary.student_number}</span>}
                  {c.department && ` · ${c.department}`}{c.specialization && ` · ${specializationLabel(c.specialization)}`}
                </p>
                {c.shift && <p className="truncate text-xs text-muted-foreground">Ca {c.shift}</p>}
                {isSpecializedDepartment(c.department) && <label className="mt-2 block w-full" onClick={(event) => event.stopPropagation()}>
                  <span className="mb-1 block text-xs font-medium text-foreground">Chọn ngạch trước khi phân bàn</span>
                  <select
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    value={specializationForDispatch(c)}
                    aria-label={`Chọn ngạch cho ${c.full_name}`}
                    onChange={(event) => setDispatchSpecializations((current) => ({
                      ...current, [c.id]: event.target.value as SpecializationCode | "",
                    }))}
                  >
                    <option value="">Chọn ngạch</option>
                    {SPECIALIZATIONS_BY_DEPARTMENT[c.department].map((item) => (
                      <option key={item.code} value={item.code}>{item.name}</option>
                    ))}
                  </select>
                </label>}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums" title="Thời gian chờ">
                  <Hourglass className="size-3" />
                  <Elapsed since={c.checked_in_at} />
                </span>
                {c.source_candidate_id && !c.shift && <Button variant="outline" size="xs" onClick={(event) => {
                  event.stopPropagation(); setFollowupCandidate(c); setFollowupDate(todayInVietnam(now)); setFollowupTime("");
                }}><CalendarClock /> Điều chỉnh lịch</Button>}
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
                  disabled={busy === c.id}
                  onClick={(e) => {
                    e.stopPropagation();
                     setMarkAbsentCandidate(c); setMarkAbsentNote("");
                  }}
                >
                  <UserX /> Vắng
                </Button>
              </div>
            </li>
          );
        })}
        {queue.length === 0 && (
          <li className="py-12 text-center text-sm text-muted-foreground">Chưa có thí sinh nào trong hàng chờ.</li>
        )}
      </ol>
    </section>
  );

  const tablesPanel = (
    <section className="min-h-0 space-y-4 overflow-y-auto">
      {selectedValid && (
        <div className="sticky top-0 z-10 flex items-center gap-3 rounded-xl border border-primary bg-primary/5 px-4 py-3 backdrop-blur">
          <ArrowRightLeft className="size-4 text-primary" />
          <p className="flex-1 text-sm">
            Đang chọn <b>{selectedValid.full_name}</b>. Bấm vào một bàn <span className="font-medium text-emerald-700 dark:text-emerald-400">xanh</span> để gán.
          </p>
          <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>
            Bỏ chọn
          </Button>
        </div>
      )}
      {grouped.map(({ department, rooms: departmentRooms }) => (
        <section key={department.code || "unassigned"} className={cn(
          "space-y-3 rounded-xl border bg-card/50 p-3 transition-opacity",
          selectedValid && department.code !== selectedValid.department && "opacity-45"
        )}>
          <h3 className="text-base font-bold">{department.name}{department.code && ` (${department.code})`}</h3>
          {departmentRooms.map(({ room, tables }) => (
        <div key={room.id} className="rounded-xl border bg-card p-4">
          <h3 className="font-semibold">{room.is_challenge ? `${room.name} · Debate` : room.name}</h3>
          <p className={cn("mb-3 mt-1 text-xs font-medium", room.is_configured ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300")}>
            Phòng: {room.is_configured ? "Đã kích hoạt" : "Chưa kích hoạt"}
            {tables.length === 0 && " · Chưa có bàn"}
          </p>
          {room.is_challenge && <p className="mb-3 mt-1 text-xs text-muted-foreground">
            Trong phòng: {tables.filter((desk) => desk.current_candidate_id && ["ASSIGNED", "INTERVIEWING"].includes(desk.status)).length} thí sinh
            · Chờ Debate: {cand.rows.filter((item) => item.department === tables[0]?.department && item.challenge_status === "WAITING").length}
          </p>}
          {!room.is_challenge && <div className="mb-3" />}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
            {tables.map((t) => {
              const c = t.current_candidate_id ? candById.get(t.current_candidate_id) : undefined;
              const free = t.status === "AVAILABLE";
              const interviewing = t.status === "INTERVIEWING";
              const configIssue = tableConfigurationIssue(t);
              const tableConfigured = !configIssue;
              const selectedSpecialization = selectedValid && isSpecializedDepartment(selectedValid.department) ? specializationForDispatch(selectedValid) : "";
              const eligible = dayReady && free && !t.is_paused && !room.is_challenge && !!selectedValid && !(selectedValid.source_candidate_id && !selectedValid.shift) && room.is_configured && tableConfigured && !!t.department && selectedValid.department === t.department &&
                (isSpecializedDepartment(selectedValid.department)
                  ? isSpecializationForDepartment(selectedValid.department, selectedSpecialization) && t.specialization === selectedSpecialization
                  : true);
              const isOver = dragOverTable === t.id && eligible;
              return (
                <div
                  key={t.id}
                  onDragOver={(e) => {
                    if (!dayReady || !free || t.is_paused || room.is_challenge || !room.is_configured || !tableConfigured || !t.department || (selectedValid && (selectedValid.department !== t.department || (isSpecializedDepartment(selectedValid.department) ? (!isSpecializationForDepartment(selectedValid.department, specializationForDispatch(selectedValid)) || t.specialization !== specializationForDispatch(selectedValid)) : false)))) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDragOverTable(t.id);
                  }}
                  onDragLeave={() => setDragOverTable((id) => (id === t.id ? null : id))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverTable(null);
                    if (room.is_challenge) return;
                    const id = e.dataTransfer.getData("text/plain");
                    if (id) void assign(id, t);
                  }}
                  onClick={() => onTableClick(t)}
                  role={dayReady && free && !t.is_paused && !room.is_challenge && room.is_configured && tableConfigured && (!selectedValid || eligible) ? "button" : undefined}
                  tabIndex={dayReady && free && !t.is_paused && !room.is_challenge && room.is_configured && tableConfigured && (!selectedValid || eligible) ? 0 : undefined}
                  aria-disabled={free && (!dayReady || t.is_paused || room.is_challenge || !room.is_configured || !tableConfigured || (!!selectedValid && !eligible))}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (dayReady && free && !t.is_paused && !room.is_challenge && room.is_configured && tableConfigured && (!selectedValid || eligible) && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onTableClick(t);
                    }
                  }}
                  className={cn(
                    "relative flex min-h-32 flex-col rounded-xl border-2 p-3 transition-all",
                    unreadTables.has(t.id) && "ring-2 ring-red-500/70",
                    free && dayReady &&
                      "cursor-pointer border-emerald-300 bg-emerald-50 hover:border-emerald-500 dark:border-emerald-800 dark:bg-emerald-950/50",
                    eligible && "animate-pulse-subtle border-emerald-500 ring-2 ring-emerald-500/30",
                    free && selectedValid && !eligible && "cursor-not-allowed border-muted bg-muted/30 opacity-55",
                    free && (!dayReady || !room.is_configured || !tableConfigured || room.is_challenge || t.is_paused) && "cursor-not-allowed border-muted bg-muted/30 opacity-55",
                    isOver && "scale-[1.02] border-emerald-600 ring-4 ring-emerald-500/30",
                    t.status === "ASSIGNED" && "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/50",
                    interviewing && "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/50"
                  )}
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <span className="font-semibold">{room.name} - {t.name} ({t.department ?? "Chưa chọn Ban"}{t.specialization ? ` · ${specializationLabel(t.specialization)}` : ""})</span>
                    <Button size="sm" variant={unreadTables.has(t.id) ? "destructive" : "outline"}
                      className="relative shrink-0" aria-label={`Chat với ${room.name} - ${t.name}${unreadTables.has(t.id) ? ", có tin nhắn mới" : ""}`}
                      onClick={(event) => { event.stopPropagation(); openChat(t.id); }}>
                      <MessageCircle /> {unreadTables.has(t.id) ? "Tin mới" : "Chat"}
                      {unreadTables.has(t.id) && <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-red-500 ring-2 ring-background" />}
                    </Button>
                  </div>
                  <p className={cn("mb-2 text-xs font-medium", tableConfigured ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300")}>
                    Bàn: {tableConfigured ? "Đã cấu hình" : configIssue}
                  </p>
                  <div className="mb-2 flex items-center justify-between">
                    {busy === t.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : t.is_paused ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 dark:text-amber-300"><Pause className="size-3.5" /> Tạm dừng nhận</span>
                    ) : free ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                        <CircleCheck className="size-3.5" /> Trống
                      </span>
                    ) : interviewing ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-300">
                        <Timer className="size-3.5" /> Đang PV
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Chờ vào bàn</span>
                    )}
                  </div>

                  {free ? (
                    <p className="mt-auto text-sm text-emerald-800/80 dark:text-emerald-200/80">
                      {room.is_challenge ? "Phòng Debate · Giám khảo tự nhận" : t.is_paused ? "Đang tạm dừng tiếp nhận thí sinh" : !room.is_configured ? "Phòng chưa kích hoạt" : configIssue ? configIssue : selectedValid ? eligible ? "Bấm để gán" : isSpecializedDepartment(selectedValid.department) && !isSpecializationForDepartment(selectedValid.department, specializationForDispatch(selectedValid)) ? "Chọn ngạch cho thí sinh trước" : "Khác Ban / ngạch" : "Sẵn sàng · kéo thả thí sinh vào đây"}
                    </p>
                  ) : (
                    <>
                      <p className="truncate font-medium">{c?.full_name ?? "…"}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{c?.code}</p>
                      <div className="mt-auto flex items-end justify-between pt-2">
                        <span
                          className={cn(
                            "font-mono text-2xl font-semibold tabular-nums",
                            interviewing ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"
                          )}
                        >
                          <Elapsed since={room.is_challenge ? c?.challenge_started_at ?? t.assigned_at : interviewing ? t.started_at : t.assigned_at} />
                        </span>
                        {!room.is_challenge && <Button
                          size="xs"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirm({ kind: "release", table: t, candidate: c });
                          }}
                          title="Trả thí sinh về hàng chờ và giải phóng bàn"
                        >
                          <Undo2 /> Trả về
                        </Button>}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            {tables.length === 0 && <p className="text-sm text-muted-foreground">Phòng chưa có bàn.</p>}
          </div>
        </div>
          ))}
        </section>
      ))}
      {grouped.length === 0 && (
        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Chưa cấu hình phòng/bàn. Admin vào mục “Phòng & Bàn” để tạo.
        </p>
      )}
    </section>
  );

  return (
    <div className="flex h-dvh flex-col bg-background">
      <AppHeader title="Điều phối · Phòng chờ" subtitle={staffName} status={status}>
        <Link href="/operations" target="_blank" rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted">
          <ClipboardList className="size-4" /> <span className="hidden sm:inline">Tra cứu & lịch sử</span>
        </Link>
        {unreadTables.size > 0 && <Button variant="destructive" size="sm" onClick={() => openChat([...unreadTables][0])}>
          <span className="size-2 rounded-full bg-white" /> {unreadTables.size} bàn có tin mới
        </Button>}
        <span className="hidden rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800 tabular-nums md:inline dark:bg-emerald-950 dark:text-emerald-200">
          {freeCount} bàn trống
        </span>
      </AppHeader>

      <div className="app-sticky-toolbar flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm sm:gap-3 sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAbsenceOpen(true)}>Quản lý vắng mặt ({cand.rows.filter((item) => item.status === "ABSENT").length})</Button>
          {selectedValid && <Button variant="outline" size="sm" onClick={() => setRequestCandidate(selectedValid)}><CalendarClock /> Yêu cầu đổi lịch</Button>}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button variant="outline" size="sm" onClick={openTvConfig}><Settings2 /> Cấu hình TV · {visibleTvDepartments.length} ban</Button>
          <a href="/display" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center rounded-md border border-primary bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90 active:scale-[0.98]">
            Mở màn hình chờ trên tab mới
          </a>
        </div>
      </div>
      {!dayReady && <p className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900">Bố trí ngày {dayState.rows[0]?.day ? dayLabel(dayState.rows[0].day) : "trước"} đã khóa. Hệ thống sẽ áp dụng bố trí ngày {dayLabel(todayInVietnam(now))} sau khi các ca cũ hoàn tất và lịch hôm nay đã được lưu.</p>}

      <div className="pointer-events-none fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[45] flex flex-col gap-2 sm:right-4 sm:left-auto sm:w-96" aria-live="polite">
        {alarms.map((alarm) => <div key={alarm.id} role="status" className={cn(
          "pointer-events-auto rounded-xl border border-amber-300 bg-background p-4 shadow-xl transition-opacity duration-1000",
          alarm.fading && "opacity-0"
        )}>
          <div className="flex items-start gap-2">
            <BellRing className="mt-0.5 size-5 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{alarm.label} đã sẵn sàng</p>
              <p className="text-sm text-muted-foreground">{alarm.body}</p>
            </div>
            <button type="button" aria-label="Đóng thông báo" onClick={() => setAlarms((current) => current.filter((item) => item.id !== alarm.id))}><X className="size-4" /></button>
          </div>
          <Button size="xs" variant="outline" className="mt-2" onClick={() => openChat(alarm.tableId)}><MessageCircle /> Chat</Button>
        </div>)}
      </div>

      <Dialog open={!!chatTableId} onOpenChange={(open) => !open && setChatTableId(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Chat · {roomById.get(tbl.rows.find((table) => table.id === chatTableId)?.room_id ?? "")?.name} - {tbl.rows.find((table) => table.id === chatTableId)?.name}</DialogTitle></DialogHeader>
          {chatTableId && <OpsChat key={chatTableId} tableId={chatTableId} selfId={selfId} role={chatIdentity} />}
        </DialogContent>
      </Dialog>
      <Dialog open={tvConfigOpen} onOpenChange={setTvConfigOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ban hiển thị trên TV</DialogTitle>
            <p className="text-sm text-muted-foreground">Tắt ban không phỏng vấn để các ban còn lại có thêm không gian. Màn hình TV cập nhật ngay sau khi lưu.</p>
          </DialogHeader>
          <div className="grid gap-2">
            {DEPARTMENTS.map((department) => {
              const enabled = tvDepartmentDraft.includes(department.code);
              return <button key={department.code} type="button" role="switch" aria-checked={enabled}
                onClick={() => toggleTvDepartment(department.code)}
                className="flex min-h-12 items-center justify-between gap-3 rounded-lg border px-3 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                <span className="font-medium">{department.name} <span className="font-mono text-xs text-muted-foreground">{department.code}</span></span>
                <span aria-hidden="true" className={cn("flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors", enabled ? "bg-primary" : "bg-muted-foreground/30")}>
                  <span className={cn("size-5 rounded-full bg-white shadow-sm transition-transform", enabled && "translate-x-5")} />
                </span>
              </button>;
            })}
          </div>
          <p className="text-xs text-muted-foreground">Đang chọn {tvDepartmentDraft.length}/{DEPARTMENTS.length} ban</p>
          <Button onClick={() => void saveTvConfig()} disabled={tvSaving} className="w-full">
            {tvSaving && <Loader2 className="animate-spin" />} Lưu cấu hình TV
          </Button>
        </DialogContent>
      </Dialog>
      <AbsenceManagerDialog open={absenceOpen} onClose={() => setAbsenceOpen(false)} candidates={cand.rows} onChanged={() => void cand.refetch()} />
      <ScheduleRequestDialog candidate={requestCandidate} candidates={cand.rows} onClose={() => setRequestCandidate(null)} />
      <Dialog open={markAbsentCandidate !== null} onOpenChange={(open) => !open && setMarkAbsentCandidate(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Đánh vắng · {markAbsentCandidate?.full_name}</DialogTitle></DialogHeader>
          <form onSubmit={saveAbsent} className="grid gap-3">
            <Textarea value={markAbsentNote} onChange={(event) => setMarkAbsentNote(event.target.value)} maxLength={2000}
              placeholder="Ghi chú: chuyển ca, không liên lạc được..." />
            <Button type="submit" variant="destructive" disabled={busy !== null}>{busy && <Loader2 className="animate-spin" />} Xác nhận vắng mặt</Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={followupCandidate !== null} onOpenChange={(open) => !open && setFollowupCandidate(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Điều chỉnh lịch Ban thứ hai · {followupCandidate?.full_name}</DialogTitle></DialogHeader>
          <form onSubmit={saveFollowup} className="grid gap-4">
            <p className="text-sm text-muted-foreground">Chọn Ca hôm nay để tiếp tục chờ điều phối. Chọn ngày sau để chuyển lượt phỏng vấn sang ngày đó.</p>
            <ScheduleFields idPrefix="followup" candidates={cand.rows} department={followupCandidate?.department ?? ""}
              date={followupDate} time={followupTime} onDateChange={setFollowupDate} onTimeChange={setFollowupTime} />
            <Button type="submit" disabled={busy !== null || !isFutureInterviewSlot(followupDate, followupTime, now)}>
              {busy && <Loader2 className="animate-spin" />} Lưu lịch phỏng vấn
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Desktop: 2 cột */}
      <main className="mx-auto hidden min-h-0 w-full max-w-screen-2xl flex-1 grid-cols-[minmax(320px,400px)_1fr] gap-4 p-4 lg:grid">
        {queuePanel}
        {tablesPanel}
      </main>

      {/* Mobile/Tablet dọc: Tabs */}
      <main className="flex min-h-0 flex-1 flex-col p-3 lg:hidden">
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="grid h-10! w-full grid-cols-2">
            <TabsTrigger value="queue">Hàng chờ ({queue.length})</TabsTrigger>
            <TabsTrigger value="tables">Bàn ({freeCount} trống)</TabsTrigger>
          </TabsList>
          <TabsContent value="queue" className="flex min-h-0 flex-1 flex-col">
            {queuePanel}
          </TabsContent>
          <TabsContent value="tables" className="min-h-0 flex-1 overflow-y-auto">
            {tablesPanel}
          </TabsContent>
        </Tabs>
      </main>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trả thí sinh về hàng chờ?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "release" ? `${confirm.candidate?.full_name ?? "Thí sinh"} sẽ quay lại hàng chờ (giữ nguyên thứ tự) và ${confirm.table.name} được giải phóng. Đồng hồ phỏng vấn (nếu có) sẽ bị huỷ.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={doConfirm}>
              Xác nhận
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
