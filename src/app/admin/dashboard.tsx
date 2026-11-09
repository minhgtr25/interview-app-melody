"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Clock, UserCheck, Mic, CircleCheckBig, UserX, Users, Timer, ShieldAlert } from "lucide-react";
import { LiveIndicator } from "@/components/app-header";
import { Elapsed } from "@/components/clock";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRows } from "@/hooks/use-realtime-rows";
import { errorMessage, formatDuration } from "@/lib/format";
import type { Candidate, InterviewTable, Room } from "@/lib/types";
import { cn } from "@/lib/utils";

const CARDS = [
  { key: "NOT_ARRIVED", label: "Chưa đến", icon: Clock, bar: "bg-slate-400", text: "text-slate-700 dark:text-slate-300" },
  { key: "WAITING", label: "Đã check-in", icon: UserCheck, bar: "bg-blue-500", text: "text-blue-700 dark:text-blue-300" },
  { key: "INTERVIEWING", label: "Đang phỏng vấn", icon: Mic, bar: "bg-orange-500", text: "text-orange-700 dark:text-orange-300" },
  { key: "COMPLETED", label: "Đã xong", icon: CircleCheckBig, bar: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
  { key: "ABSENT", label: "Vắng", icon: UserX, bar: "bg-red-500", text: "text-red-700 dark:text-red-300" },
] as const;

type Bucket = (typeof CARDS)[number]["key"];

function bucketOf(c: Candidate): Bucket {
  switch (c.status) {
    case "CHECKED_IN":
      return "WAITING";
    case "ASSIGNED":
    case "INTERVIEWING":
      return "INTERVIEWING"; // đã ngồi vào bàn (chờ xác nhận hoặc đang PV)
    default:
      return c.status;
  }
}

export function Dashboard({
  initialCandidates,
  initialTables,
  rooms,
}: {
  initialCandidates: Candidate[];
  initialTables: InterviewTable[];
  rooms: Room[];
}) {
  const router = useRouter();
  const [forceTable, setForceTable] = useState<InterviewTable | null>(null);
  const [forceNote, setForceNote] = useState("");
  const [forceBusy, setForceBusy] = useState(false);
  const cand = useRealtimeRows<Candidate>("candidates", initialCandidates);
  const tbl = useRealtimeRows<InterviewTable>("tables", initialTables, "sort_order");
  const status = cand.status === "live" && tbl.status === "live" ? "live" : cand.status === "offline" || tbl.status === "offline" ? "offline" : "connecting";

  const counts = useMemo(() => {
    const m: Record<Bucket, number> = { NOT_ARRIVED: 0, WAITING: 0, INTERVIEWING: 0, COMPLETED: 0, ABSENT: 0 };
    for (const c of cand.rows) m[bucketOf(c)]++;
    return m;
  }, [cand.rows]);
  const total = cand.rows.length;

  const avgDuration = useMemo(() => {
    const done = cand.rows.filter((c) => c.status === "COMPLETED" && c.duration_seconds != null);
    if (!done.length) return null;
    return done.reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / done.length;
  }, [cand.rows]);

  const byDept = useMemo(() => {
    const m = new Map<string, Record<Bucket, number> & { total: number }>();
    for (const c of cand.rows) {
      const k = c.department || "(Chưa rõ ban)";
      const row = m.get(k) ?? { NOT_ARRIVED: 0, WAITING: 0, INTERVIEWING: 0, COMPLETED: 0, ABSENT: 0, total: 0 };
      row[bucketOf(c)]++;
      row.total++;
      m.set(k, row);
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [cand.rows]);

  const candById = useMemo(() => new Map(cand.rows.map((c) => [c.id, c])), [cand.rows]);
  const roomName = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  const busyTables = tbl.rows.filter((t) => t.status !== "AVAILABLE");

  async function forceFinish() {
    if (!forceTable) return;
    if (!forceNote.trim()) return toast.error("Nhập lý do cưỡng chế kết thúc");
    setForceBusy(true);
    const { error } = await createClient().rpc("admin_force_finish_interview", {
      p_table_id: forceTable.id,
      p_note: forceNote.trim(),
    });
    setForceBusy(false);
    if (error) return toast.error(errorMessage(error));
    toast.success("Đã cưỡng chế kết thúc và nộp phiếu điểm 10");
    setForceTable(null);
    setForceNote("");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Tổng quan buổi phỏng vấn</h2>
          <p className="text-sm text-muted-foreground">
            <Users className="mr-1 inline size-3.5" />
            {total} thí sinh · {tbl.rows.length} bàn · TB {formatDuration(avgDuration)} / lượt
          </p>
        </div>
        <LiveIndicator status={status} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {CARDS.map(({ key, label, icon: Icon, text }) => (
          <div key={key} className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{label}</span>
              <Icon className={cn("size-4", text)} />
            </div>
            <p className={cn("mt-2 text-3xl font-bold tabular-nums", text)}>{counts[key]}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {total ? Math.round((counts[key] / total) * 100) : 0}%
            </p>
          </div>
        ))}
      </div>

      {/* Thanh tiến độ tổng */}
      <div className="rounded-xl border bg-card p-4">
        <p className="mb-3 text-sm font-medium">Tiến độ tổng</p>
        <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Biểu đồ tiến độ theo trạng thái">
          {CARDS.map(({ key, bar }) =>
            counts[key] > 0 ? (
              <div
                key={key}
                className={cn(bar, "transition-all duration-500")}
                style={{ width: `${(counts[key] / Math.max(total, 1)) * 100}%` }}
                title={`${CARDS.find((c) => c.key === key)?.label}: ${counts[key]}`}
              />
            ) : null
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
          {CARDS.map(({ key, label, bar }) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-full", bar)} />
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Theo ban */}
        <div className="rounded-xl border bg-card p-4">
          <p className="mb-4 text-sm font-medium">Theo ban ứng tuyển</p>
          <div className="space-y-3">
            {byDept.map(([dept, row]) => (
              <div key={dept}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="truncate">{dept}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {row.COMPLETED}/{row.total} xong
                  </span>
                </div>
                <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
                  {CARDS.map(({ key, bar }) =>
                    row[key] > 0 ? (
                      <div key={key} className={cn(bar, "transition-all duration-500")} style={{ width: `${(row[key] / row.total) * 100}%` }} />
                    ) : null
                  )}
                </div>
              </div>
            ))}
            {byDept.length === 0 && <p className="text-sm text-muted-foreground">Chưa có thí sinh. Import Excel ở mục “Thí sinh & Excel”.</p>}
          </div>
        </div>

        {/* Bàn đang hoạt động */}
        <div className="rounded-xl border bg-card p-4">
          <p className="mb-4 text-sm font-medium">
            Bàn đang hoạt động ({busyTables.length}/{tbl.rows.length})
          </p>
          <ul className="divide-y">
            {busyTables.map((t) => {
              const c = t.current_candidate_id ? candById.get(t.current_candidate_id) : undefined;
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                  <span className={cn("size-2.5 shrink-0 rounded-full", t.status === "INTERVIEWING" ? "bg-red-500" : "bg-amber-500")} />
                  <span className="w-32 shrink-0 truncate text-muted-foreground">
                    {roomName.get(t.room_id)} · {t.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{c?.full_name ?? "…"}</span>
                  <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                    <Timer className="size-3.5 text-muted-foreground" />
                    <Elapsed since={t.status === "INTERVIEWING" ? t.started_at : t.assigned_at} />
                  </span>
                  {t.status === "INTERVIEWING" && <Button size="xs" variant="destructive" onClick={() => { setForceTable(t); setForceNote(""); }}>
                    <ShieldAlert /> Cưỡng chế kết thúc
                  </Button>}
                </li>
              );
            })}
            {busyTables.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">Tất cả các bàn đang trống.</li>}
          </ul>
        </div>
      </div>
      <Dialog open={!!forceTable} onOpenChange={(open) => { if (!open && !forceBusy) setForceTable(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cưỡng chế kết thúc phỏng vấn?</DialogTitle>
            <DialogDescription>
              {forceTable && `${roomName.get(forceTable.room_id) ?? "Phòng"} · ${forceTable.name}`}
              {" — hệ thống sẽ chấm tối đa 10 điểm cho mọi tiêu chí, lưu ghi chú dưới tên Admin hoặc Support IT và giải phóng bàn."}
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 text-sm font-medium">
            Ghi chú bắt buộc
            <Textarea value={forceNote} maxLength={2000} rows={4} placeholder="Ví dụ: do quá giờ"
              onChange={(event) => setForceNote(event.target.value)} disabled={forceBusy} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForceTable(null)} disabled={forceBusy}>Huỷ</Button>
            <Button variant="destructive" onClick={() => void forceFinish()} disabled={forceBusy || !forceNote.trim()}>
              {forceBusy ? "Đang nộp…" : "Xác nhận cưỡng chế"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
