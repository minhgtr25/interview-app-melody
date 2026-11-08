"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { toast } from "sonner";
import { GripVertical, Loader2, UserX, Undo2, ArrowRightLeft, CircleCheck, Timer, Hourglass, MessageCircle, X, BellRing, Search, ClipboardList } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Elapsed } from "@/components/clock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import type { Candidate, DisplaySettings, InterviewTable, OpsMessage, Room } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DEPARTMENTS } from "@/lib/departments";
import type { DepartmentCode } from "@/lib/departments";
import { DepartmentRadio } from "@/components/department-radio";

type Confirm =
  | { kind: "absent"; candidate: Candidate }
  | { kind: "release"; table: InterviewTable; candidate?: Candidate }
  | null;

export function CoordinatorBoard({
  initialCandidates,
  initialTables,
  rooms,
  initialDisplaySettings,
  staffName,
  selfId,
}: {
  initialCandidates: Candidate[];
  initialTables: InterviewTable[];
  rooms: Room[];
  initialDisplaySettings: DisplaySettings[];
  staffName: string;
  selfId: string;
}) {
  const cand = useRealtimeRows<Candidate>("candidates", initialCandidates);
  const tbl = useRealtimeRows<InterviewTable>("tables", initialTables, "sort_order");
  const roomRows = useRealtimeRows<Room>("rooms", rooms, "sort_order");
  const displaySettings = useRealtimeRows<DisplaySettings>("display_settings", initialDisplaySettings, "id");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragOverTable, setDragOverTable] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [tab, setTab] = useState<string>("queue");
  const [queueDepartment, setQueueDepartment] = useState<DepartmentCode | "">("");
  const [queueSearch, setQueueSearch] = useState("");
  const deferredQueueSearch = normalizeText(useDeferredValue(queueSearch));
  const [chatTableId, setChatTableId] = useState<string | null>(null);
  const [unreadTables, setUnreadTables] = useState<Set<string>>(() => new Set());
  const [displayModeBusy, setDisplayModeBusy] = useState(false);
  const [alarms, setAlarms] = useState<{ id: string; label: string; body: string; tableId: string; fading: boolean }[]>([]);
  const tablesRef = useRef(tbl.rows);
  const roomsRef = useRef(roomRows.rows);
  const chatTableIdRef = useRef(chatTableId);
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

  async function setDisplayMode(mode: DisplaySettings["identity_mode"]) {
    if (displayModeBusy) return;
    setDisplayModeBusy(true);
    const previous = displaySettings.rows.find((row) => row.id === "main")?.identity_mode ?? "NAME";
    displaySettings.patchRow("main", { identity_mode: mode });
    const { error } = await createClient().from("display_settings").update({ identity_mode: mode }).eq("id", "main");
    setDisplayModeBusy(false);
    if (error) {
      displaySettings.patchRow("main", { identity_mode: previous });
      toast.error(errorMessage(error));
    }
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

  const status = cand.status === "live" && tbl.status === "live" && roomRows.status === "live" ? "live" : cand.status === "offline" || tbl.status === "offline" || roomRows.status === "offline" ? "offline" : "connecting";

  const candById = useMemo(() => new Map(cand.rows.map((c) => [c.id, c])), [cand.rows]);

  const queue = useMemo(
    () =>
      cand.rows
        .filter((c) => c.status === "CHECKED_IN" && (!queueDepartment || c.department === queueDepartment)
          && (!deferredQueueSearch || normalizeText(`${c.full_name} ${c.code} ${c.student_number ?? ""} ${c.phone ?? ""}`).includes(deferredQueueSearch)))
        .sort((a, b) => (a.checked_in_at ?? "").localeCompare(b.checked_in_at ?? "")),
    [cand.rows, queueDepartment, deferredQueueSearch]
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
        .filter(({ tables }) => tables.length > 0) }))
      .filter((group) => group.rooms.length > 0);
  }, [tbl.rows, roomRows.rows]);

  const roomById = useMemo(() => new Map(roomRows.rows.map((room) => [room.id, room])), [roomRows.rows]);
  const freeCount = tbl.rows.filter((t) => t.status === "AVAILABLE" && t.department && roomById.get(t.room_id)?.is_configured).length;
  const selected = selectedId ? candById.get(selectedId) : undefined;
  // Bỏ chọn nếu thí sinh đã rời hàng chờ (do người khác gán)
  const selectedValid = selected && selected.status === "CHECKED_IN" ? selected : undefined;

  async function assign(candidateId: string, table: InterviewTable) {
    const c = candById.get(candidateId);
    if (!c || c.status !== "CHECKED_IN") return toast.error("Thí sinh không còn ở hàng chờ");
    if (table.status !== "AVAILABLE") return toast.error("Bàn này đang bận");
    if (!roomById.get(table.room_id)?.is_configured) return toast.error("Phòng chưa được kích hoạt");
    if (!table.department || c.department !== table.department) return toast.error("Ban của thí sinh không khớp Ban phụ trách bàn");
    setBusy(table.id);
    const now = new Date().toISOString();
    cand.patchRow(c.id, { status: "ASSIGNED", table_id: table.id, assigned_at: now });
    tbl.patchRow(table.id, { status: "ASSIGNED", current_candidate_id: c.id, assigned_at: now });
    const { error } = await createClient().rpc("assign_candidate", { p_candidate_id: c.id, p_table_id: table.id });
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
    if (action.kind === "absent") {
      setBusy(action.candidate.id);
      const { error } = await createClient().rpc("mark_absent", { p_candidate_id: action.candidate.id });
      setBusy(null);
      if (error) return toast.error(errorMessage(error));
      if (selectedId === action.candidate.id) setSelectedId(null);
      toast.success(`Đã đánh vắng: ${action.candidate.full_name}`);
    } else {
      setBusy(action.table.id);
      const { error } = await createClient().rpc("return_to_queue", { p_table_id: action.table.id });
      setBusy(null);
      if (error) return toast.error(errorMessage(error));
      toast.success(`Đã giải phóng ${action.table.name}`);
    }
  }

  function onTableClick(t: InterviewTable) {
    if (t.status !== "AVAILABLE") return;
    if (!selectedValid) {
      toast.info("Chọn một thí sinh trong hàng chờ trước");
      setTab("queue");
      return;
    }
    if (!roomById.get(t.room_id)?.is_configured || !t.department || selectedValid.department !== t.department) return;
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
        <div className="relative"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={queueSearch} onChange={(event) => setQueueSearch(event.target.value)}
            className="pl-9" placeholder="Tìm tên, mã hoặc SĐT thí sinh…" aria-label="Tìm thí sinh trong hàng chờ" />
        </div>
        <DepartmentRadio name="coordinator-queue-department" value={queueDepartment} onChange={setQueueDepartment} allowAll />
      </div>
      <ol className="flex-1 space-y-2 overflow-y-auto p-3">
        {queue.map((c, i) => {
          const isSel = selectedValid?.id === c.id;
          return (
            <li
              key={c.id}
              draggable
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
                <p className="truncate font-medium">{c.full_name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{c.code}</span>
                  {c.student_number && <span className="font-mono"> · MSSV {c.student_number}</span>}
                  {c.department && ` · ${c.department}`}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums" title="Thời gian chờ">
                  <Hourglass className="size-3" />
                  <Elapsed since={c.checked_in_at} />
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
                  disabled={busy === c.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirm({ kind: "absent", candidate: c });
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
          <h3 className="mb-3 font-semibold">{room.name}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
            {tables.map((t) => {
              const c = t.current_candidate_id ? candById.get(t.current_candidate_id) : undefined;
              const free = t.status === "AVAILABLE";
              const interviewing = t.status === "INTERVIEWING";
              const eligible = free && !!selectedValid && room.is_configured && !!t.department && selectedValid.department === t.department;
              const isOver = dragOverTable === t.id && eligible;
              return (
                <div
                  key={t.id}
                  onDragOver={(e) => {
                    if (!free || !room.is_configured || !t.department || (selectedValid && selectedValid.department !== t.department)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDragOverTable(t.id);
                  }}
                  onDragLeave={() => setDragOverTable((id) => (id === t.id ? null : id))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverTable(null);
                    const id = e.dataTransfer.getData("text/plain");
                    if (id) void assign(id, t);
                  }}
                  onClick={() => onTableClick(t)}
                  role={free && (!selectedValid || eligible) ? "button" : undefined}
                  tabIndex={free && (!selectedValid || eligible) ? 0 : undefined}
                  aria-disabled={free && !!selectedValid && !eligible}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (free && (!selectedValid || eligible) && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onTableClick(t);
                    }
                  }}
                  className={cn(
                    "relative flex min-h-32 flex-col rounded-xl border-2 p-3 transition-all",
                    unreadTables.has(t.id) && "ring-2 ring-red-500/70",
                    free &&
                      "cursor-pointer border-emerald-300 bg-emerald-50 hover:border-emerald-500 dark:border-emerald-800 dark:bg-emerald-950/50",
                    eligible && "animate-pulse-subtle border-emerald-500 ring-2 ring-emerald-500/30",
                    free && selectedValid && !eligible && "cursor-not-allowed border-muted bg-muted/30 opacity-55",
                    free && (!room.is_configured || !t.department) && "cursor-not-allowed border-muted bg-muted/30 opacity-55",
                    isOver && "scale-[1.02] border-emerald-600 ring-4 ring-emerald-500/30",
                    t.status === "ASSIGNED" && "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/50",
                    interviewing && "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/50"
                  )}
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <span className="font-semibold">{room.name} - {t.name} ({t.department ?? "Chưa chọn Ban"})</span>
                    <Button size="sm" variant={unreadTables.has(t.id) ? "destructive" : "outline"}
                      className="relative shrink-0" aria-label={`Chat với ${room.name} - ${t.name}${unreadTables.has(t.id) ? ", có tin nhắn mới" : ""}`}
                      onClick={(event) => { event.stopPropagation(); openChat(t.id); }}>
                      <MessageCircle /> {unreadTables.has(t.id) ? "Tin mới" : "Chat"}
                      {unreadTables.has(t.id) && <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-red-500 ring-2 ring-background" />}
                    </Button>
                  </div>
                  <div className="mb-2 flex items-center justify-between">
                    {busy === t.id ? (
                      <Loader2 className="size-4 animate-spin" />
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
                      {!room.is_configured ? "Phòng chưa kích hoạt" : !t.department ? "Admin cần chọn Ban" : selectedValid ? eligible ? "Bấm để gán" : "Khác Ban thí sinh" : "Sẵn sàng · kéo thả thí sinh vào đây"}
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
                          <Elapsed since={interviewing ? t.started_at : t.assigned_at} />
                        </span>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirm({ kind: "release", table: t, candidate: c });
                          }}
                          title="Trả thí sinh về hàng chờ và giải phóng bàn"
                        >
                          <Undo2 /> Trả về
                        </Button>
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
    <div className="flex h-dvh flex-col bg-muted/30">
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

      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">TV hiển thị:</span>
          <fieldset className="flex items-center gap-1" disabled={displayModeBusy}>
            {([ ["NAME", "Họ tên"], ["CODE", "Mã số"] ] as const).map(([mode, label]) => (
              <label key={mode} className={cn("cursor-pointer rounded-md border px-3 py-1.5 font-medium active:scale-[0.98]", (displaySettings.rows.find((row) => row.id === "main")?.identity_mode ?? "NAME") === mode ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted")}>
                <input type="radio" name="display-mode" value={mode} checked={(displaySettings.rows.find((row) => row.id === "main")?.identity_mode ?? "NAME") === mode} onChange={() => void setDisplayMode(mode)} className="sr-only" />
                {label}
              </label>
            ))}
          </fieldset>
        </div>
        <a href="/display" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center rounded-md border border-primary bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90 active:scale-[0.98]">
          Mở màn hình chờ trên tab mới
        </a>
      </div>

      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col gap-2 sm:right-4 sm:left-auto sm:w-96" aria-live="polite">
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
          {chatTableId && <OpsChat key={chatTableId} tableId={chatTableId} selfId={selfId} role="coordinator" />}
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
            <AlertDialogTitle>
              {confirm?.kind === "absent" ? "Đánh dấu vắng mặt?" : "Trả thí sinh về hàng chờ?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "absent"
                ? `${confirm.candidate.full_name} sẽ bị bỏ lượt. Bàn tiếp đón có thể check-in lại nếu thí sinh quay lại.`
                : confirm?.kind === "release"
                  ? `${confirm.candidate?.full_name ?? "Thí sinh"} sẽ quay lại hàng chờ (giữ nguyên thứ tự) và ${confirm.table.name} được giải phóng. Đồng hồ phỏng vấn (nếu có) sẽ bị huỷ.`
                  : ""}
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
