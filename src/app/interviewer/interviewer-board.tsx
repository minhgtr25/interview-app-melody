"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { toast } from "sonner";
import {
  BellRing, CheckCircle2, ExternalLink, Loader2, Minus, Plus, Send, Undo2, Coffee, Mail, Phone, Timer, Megaphone, MessageCircle,
} from "lucide-react";
import { useOpsChannel } from "@/hooks/use-ops-channel";
import { AppHeader } from "@/components/app-header";
import { Elapsed } from "@/components/clock";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OpsChat } from "@/components/ops-chat";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useRealtimeRows } from "@/hooks/use-realtime-rows";
import { createClient, prepareRealtime } from "@/lib/supabase/client";
import { errorMessage, safeUrl } from "@/lib/format";
import type { Candidate, InterviewTable, OpsMessage, Room, RubricCriterion } from "@/lib/types";
import { cn } from "@/lib/utils";

type Draft = { scores: Record<string, number>; comment: string };

const draftKey = (candidateId: string) => `eval-draft:${candidateId}`;

function loadDraft(candidateId: string): Draft {
  try {
    const raw = localStorage.getItem(draftKey(candidateId));
    if (raw) {
      const d = JSON.parse(raw) as Draft;
      if (d && typeof d === "object" && d.scores) return { scores: d.scores, comment: d.comment ?? "" };
    }
  } catch {
    /* storage bị chặn */
  }
  return { scores: {}, comment: "" };
}

function saveDraft(candidateId: string, d: Draft) {
  try {
    localStorage.setItem(draftKey(candidateId), JSON.stringify(d));
  } catch {
    /* bỏ qua */
  }
}

function clearDraft(candidateId: string) {
  try {
    localStorage.removeItem(draftKey(candidateId));
  } catch {
    /* bỏ qua */
  }
}

function ScorePicker({
  criterion,
  value,
  onChange,
}: {
  criterion: RubricCriterion;
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  const max = criterion.max_score;
  if (max <= 10) {
    // Lưới nút 1..max (0 điểm hiếm khi dùng, vẫn chọn được qua nút riêng)
    const nums = Array.from({ length: max }, (_, i) => i + 1);
    return (
      <div className={cn("grid gap-1.5", max <= 5 ? "grid-cols-5" : "grid-cols-5 sm:grid-cols-10")}>
        {nums.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-pressed={value === n}
            className={cn(
              "h-12 rounded-lg border text-lg font-semibold tabular-nums transition-all active:scale-95",
              value === n
                ? "border-primary bg-primary text-primary-foreground shadow-sm"
                : "bg-background hover:border-primary/50 hover:bg-muted"
            )}
          >
            {n}
          </button>
        ))}
      </div>
    );
  }
  const v = value ?? 0;
  return (
    <div className="flex items-center gap-3">
      <Button type="button" variant="outline" className="size-12" onClick={() => onChange(Math.max(0, v - 1))} aria-label="Giảm">
        <Minus />
      </Button>
      <span className="w-20 text-center font-mono text-3xl font-semibold tabular-nums">
        {value ?? "–"}
        <span className="text-base text-muted-foreground">/{max}</span>
      </span>
      <Button type="button" variant="outline" className="size-12" onClick={() => onChange(Math.min(max, v + 1))} aria-label="Tăng">
        <Plus />
      </Button>
    </div>
  );
}

export function InterviewerBoard({
  tableId,
  initialTables,
  initialCandidates,
  rooms,
  rubric,
  interviewerName,
  selfId,
}: {
  tableId: string;
  initialTables: InterviewTable[];
  initialCandidates: Candidate[];
  rooms: Room[];
  rubric: RubricCriterion[];
  interviewerName: string;
  selfId: string;
}) {
  const tbl = useRealtimeRows<InterviewTable>("tables", initialTables, "sort_order");
  const roomRows = useRealtimeRows<Room>("rooms", rooms, "sort_order");
  const cand = useRealtimeRows<Candidate>("candidates", initialCandidates);
  const patchTable = tbl.patchRow;
  const setCandidates = cand.setRows;
  const table = tbl.rows.find((t) => t.id === tableId);
  const room = roomRows.rows.find((r) => r.id === table?.room_id);
  const candidate = table?.current_candidate_id
    ? cand.rows.find((c) => c.id === table.current_candidate_id)
    : undefined;

  const status = tbl.status === "live" && cand.status === "live" ? "live" : tbl.status === "offline" || cand.status === "offline" ? "offline" : "connecting";

  const [draft, setDraft] = useState<Draft>({ scores: {}, comment: "" });
  const [busy, setBusy] = useState<"start" | "submit" | "return" | null>(null);
  const [confirm, setConfirm] = useState<"submit" | "return" | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(false);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  function openChat() { setChatUnread(false); setChatOpen(true); }

  useEffect(() => {
    const client = createClient();
    let active = true;
    let channel: RealtimeChannel | null = null;
    void prepareRealtime().then(() => {
      if (!active) return;
      channel = client.channel(`interviewer-chat:${tableId}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ops_messages", filter: `table_id=eq.${tableId}` },
        (payload: RealtimePostgresChangesPayload<OpsMessage>) => {
          const message = payload.new as OpsMessage;
          if (message.kind !== "CHAT" || message.sender_id === selfId || chatOpenRef.current) return;
          setChatUnread(true);
          toast.info("Điều phối gửi tin nhắn", {
            description: message.body,
            duration: 10000,
            action: { label: "Mở chat", onClick: openChat },
          });
        })
      .subscribe();
    }).catch(() => { /* chat dialog can still load messages over REST */ });
    return () => { active = false; if (channel) void client.removeChannel(channel); };
  }, [tableId, selfId]);

  // Keep the assigned table in sync even when a Postgres Changes event is missed.
  useEffect(() => {
    let active = true;
    const client = createClient();
    const syncTable = async () => {
      const { data: latest } = await client.from("tables").select("*").eq("id", tableId).maybeSingle();
      if (!active || !latest) return;
      patchTable(tableId, latest as InterviewTable);
      const candidateId = latest.current_candidate_id as string | null;
      if (candidateId) {
        const { data: assigned } = await client.from("candidates").select("*").eq("id", candidateId).maybeSingle();
        if (active && assigned) setCandidates((previous) => {
          const next = assigned as Candidate;
          return previous.some((item) => item.id === next.id)
            ? previous.map((item) => item.id === next.id ? next : item)
            : [...previous, next];
        });
      }
    };
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void syncTable(); }, 5000);
    return () => { active = false; window.clearInterval(poll); };
  }, [tableId, patchTable, setCandidates]);
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Nạp nháp khi đổi thí sinh (giữ điểm nếu lỡ tải lại trang)
  const candId = candidate?.id;
  useEffect(() => {
    setDraft(candId ? loadDraft(candId) : { scores: {}, comment: "" });
  }, [candId]);

  // Thông báo khi có thí sinh mới được gán
  const prevStatus = useRef(table?.status);
  useEffect(() => {
    const now = table?.status;
    if (now === "ASSIGNED" && prevStatus.current !== "ASSIGNED") {
      try {
        navigator.vibrate?.([120, 80, 120]);
      } catch {
        /* không hỗ trợ */
      }
      toast.info("Có thí sinh mới được gán vào bàn của bạn", { duration: 6000 });
    }
    prevStatus.current = now;
  }, [table?.status]);

  function update(patch: Partial<Draft>) {
    setDraft((d) => {
      const next = { ...d, ...patch, scores: { ...d.scores, ...(patch.scores ?? {}) } };
      if (candId) saveDraft(candId, next);
      return next;
    });
  }

  const missing = useMemo(() => rubric.filter((r) => draft.scores[r.id] == null), [rubric, draft.scores]);
  const avg = useMemo(() => {
    let sum = 0;
    let w = 0;
    for (const r of rubric) {
      const s = draft.scores[r.id];
      if (s == null) continue;
      sum += (s / r.max_score) * 10 * Number(r.weight);
      w += Number(r.weight);
    }
    return w > 0 ? sum / w : null;
  }, [rubric, draft.scores]);

  async function start() {
    setBusy("start");
    const { error } = await createClient().rpc("start_interview", { p_table_id: tableId });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    const now = new Date().toISOString();
    tbl.patchRow(tableId, { status: "INTERVIEWING", started_at: now });
    if (candidate) cand.patchRow(candidate.id, { status: "INTERVIEWING", interview_started_at: now });
    toast.success("Bắt đầu phỏng vấn");
  }

  async function submit() {
    setConfirm(null);
    if (!candidate) return;
    setBusy("submit");
    const { error } = await createClient().rpc("submit_evaluation", {
      p_table_id: tableId,
      p_scores: draft.scores,
      p_comment: draft.comment,
    });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    clearDraft(candidate.id);
    tbl.patchRow(tableId, { status: "AVAILABLE", current_candidate_id: null, assigned_at: null, started_at: null });
    cand.patchRow(candidate.id, { status: "COMPLETED", interview_ended_at: new Date().toISOString() });
    toast.success(`Đã nộp đánh giá cho ${candidate.full_name}`);
  }

  async function returnToQueue() {
    setConfirm(null);
    setBusy("return");
    const { error } = await createClient().rpc("return_to_queue", { p_table_id: tableId });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    if (candidate) clearDraft(candidate.id);
    tbl.patchRow(tableId, { status: "AVAILABLE", current_candidate_id: null, assigned_at: null, started_at: null });
    if (candidate) cand.patchRow(candidate.id, { status: "CHECKED_IN", table_id: null, assigned_at: null, interview_started_at: null });
    toast.success("Đã trả thí sinh về phòng chờ");
  }

  const ops = useOpsChannel();
  const [lastCall, setLastCall] = useState(0);
  const [callBusy, setCallBusy] = useState(false);
  const callInFlight = useRef(false);
  const callStorageKey = `coordinator-call:${tableId}`;
  useEffect(() => {
    const restoreCall = () => {
      try { setLastCall(Number(localStorage.getItem(callStorageKey)) || 0); }
      catch { setLastCall(0); }
    };
    restoreCall();
    const onStorage = (event: StorageEvent) => { if (event.key === callStorageKey) restoreCall(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [callStorageKey]);
  const callWait = Math.max(0, Math.ceil((lastCall + 30000 - nowMs) / 1000));
  async function callCoordinator() {
    if (!table || callInFlight.current || callWait > 0) return;
    callInFlight.current = true;
    setCallBusy(true);
    try {
      const ok = await ops.send({
        type: "CALL_COORDINATOR",
        tableId,
        tableLabel,
        from: interviewerName,
        reason: table.status === "AVAILABLE" ? "Bàn trống, sẵn sàng nhận thí sinh" : "Cần hỗ trợ tại bàn",
      });
      if (!ok) return toast.error("Không gửi được, kiểm tra kết nối mạng");
      const sentAt = Date.now();
      setLastCall(sentAt);
      try { localStorage.setItem(callStorageKey, String(sentAt)); } catch { /* storage bị chặn */ }
      toast.success("Đã gọi điều phối viên");
    } catch {
      toast.error("Không gửi được, kiểm tra kết nối mạng");
    } finally {
      callInFlight.current = false;
      setCallBusy(false);
    }
  }

  const tableLabel = table ? `Phòng: ${room?.name ?? "—"} | ${table.name} | Ban: ${table.department ?? "Chưa chọn"}` : "Bàn phỏng vấn";
  const cvUrl = safeUrl(candidate?.cv_url);

  return (
    <div className="min-h-dvh bg-muted/30">
      <AppHeader title={tableLabel} subtitle={interviewerName} status={status}>
        <Button variant="outline" size="sm" onClick={openChat} aria-label="Chat với điều phối" title="Chat với điều phối" className="relative">
          <MessageCircle /><span className="hidden md:inline">Chat</span>
          {chatUnread && <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-red-500" />}
        </Button>
        <Button variant="outline" size="sm" onClick={callCoordinator}
          disabled={!table || callBusy || callWait > 0}
          aria-label={callWait > 0 ? `Gọi lại điều phối sau ${callWait} giây` : "Gọi điều phối viên"}
          title={callWait > 0 ? `Gọi lại sau ${callWait} giây` : "Gọi điều phối viên"}>
          <Megaphone />
          <span>{callWait > 0 ? `Gọi lại ${callWait}s` : "Gọi điều phối"}</span>
        </Button>
        {table?.status === "INTERVIEWING" && (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 font-mono text-lg font-semibold text-white tabular-nums">
            <Timer className="size-4" />
            <Elapsed since={table.started_at} />
          </span>
        )}
      </AppHeader>

      <Dialog open={chatOpen} onOpenChange={setChatOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Chat với điều phối · {room?.name} - {table?.name}</DialogTitle></DialogHeader>
          <OpsChat tableId={tableId} selfId={selfId} role="interviewer" />
        </DialogContent>
      </Dialog>

      <main className="mx-auto max-w-3xl px-4 py-5 pb-32">
        {!table && <p className="py-16 text-center text-muted-foreground">Không tìm thấy bàn được phân công.</p>}

        {/* Trống */}
        {table?.status === "AVAILABLE" && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <div className="flex size-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              <Coffee className="size-8" />
            </div>
            <p className="text-lg font-semibold">Bàn đang trống</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Điều phối viên sẽ gán thí sinh tiếp theo. Màn hình tự cập nhật, không cần tải lại.
            </p>
          </div>
        )}

        {/* Được gán: chờ xác nhận */}
        {table?.status === "ASSIGNED" && candidate && (
          <div className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-6 text-center shadow-lg dark:bg-amber-950/60">
            <BellRing className="mx-auto mb-3 size-10 animate-bounce text-amber-600" />
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Thí sinh được gán vào bàn</p>
            <p className="mt-2 text-2xl font-bold">{candidate.full_name}</p>
            <p className="mt-1 font-mono text-sm text-muted-foreground">{candidate.code}</p>
            <p className="mt-1 text-sm text-muted-foreground">{[candidate.department, candidate.shift].filter(Boolean).join(" · ")}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              Đã gán <Elapsed since={table.assigned_at} /> trước
            </p>
            <Button
              onClick={start}
              disabled={busy !== null}
              className="mt-6 h-16 w-full bg-emerald-600 text-lg font-semibold text-white hover:bg-emerald-700"
            >
              {busy === "start" ? <Loader2 className="size-6! animate-spin" /> : <CheckCircle2 className="size-6!" />}
              Xác nhận thí sinh đã vào bàn
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirm("return")}
              disabled={busy !== null}
              className="mt-3 h-11 w-full"
            >
              <Undo2 /> Nhầm thí sinh - Trả về phòng chờ
            </Button>
          </div>
        )}

        {/* Đang phỏng vấn */}
        {table?.status === "INTERVIEWING" && candidate && (
          <div className="space-y-5">
            <section className="rounded-2xl border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xl font-bold">{candidate.full_name}</p>
                  <p className="font-mono text-sm text-muted-foreground">{candidate.code}</p>
                </div>
                {cvUrl ? (
                  <a
                    href={cvUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ variant: "outline" }), "h-11 shrink-0")}
                  >
                    <ExternalLink /> Mở CV
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">Không có CV</span>
                )}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Ban ứng tuyển</dt>
                  <dd className="font-medium">{candidate.department || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Ca</dt>
                  <dd className="font-medium">{candidate.shift || "—"}</dd>
                </div>
                {candidate.phone && (
                  <div className="flex items-center gap-1.5">
                    <Phone className="size-3.5 text-muted-foreground" />
                    <span className="tabular-nums">{candidate.phone}</span>
                  </div>
                )}
                {candidate.email && (
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Mail className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{candidate.email}</span>
                  </div>
                )}
              </dl>
            </section>

            <section className="space-y-4">
              {rubric.map((r, i) => (
                <div key={r.id} className="rounded-2xl border bg-card p-4">
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <div>
                      <p className="font-semibold">
                        {i + 1}. {r.name}
                      </p>
                      {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      /{r.max_score}
                      {Number(r.weight) !== 1 && ` · ×${r.weight}`}
                    </span>
                  </div>
                  <ScorePicker
                    criterion={r}
                    value={draft.scores[r.id]}
                    onChange={(v) => update({ scores: { [r.id]: v } })}
                  />
                </div>
              ))}
              {rubric.length === 0 && (
                <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
                  Admin chưa cấu hình tiêu chí chấm. Bạn vẫn có thể ghi nhận xét và nộp.
                </p>
              )}

              <div className="rounded-2xl border bg-card p-4">
                <label htmlFor="comment" className="mb-2 block font-semibold">
                  Nhận xét
                </label>
                <Textarea
                  id="comment"
                  value={draft.comment}
                  onChange={(e) => update({ comment: e.target.value })}
                  placeholder="Điểm mạnh, điểm cần cải thiện, đề xuất…"
                  className="min-h-28 text-base"
                  maxLength={5000}
                />
              </div>
            </section>
          </div>
        )}
      </main>

      {/* Thanh hành động cố định đáy màn hình khi đang phỏng vấn */}
      {table?.status === "INTERVIEWING" && candidate && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Button
              variant="outline"
              className="h-14 shrink-0 px-3"
              onClick={() => setConfirm("return")}
              disabled={busy !== null}
              title="Nhầm thí sinh - Trả về phòng chờ"
            >
              <Undo2 />
              <span className="hidden sm:inline">Nhầm thí sinh</span>
            </Button>
            <div className="hidden text-center sm:block">
              <p className="text-xs text-muted-foreground">Điểm TB</p>
              <p className="font-mono text-xl font-semibold tabular-nums">{avg == null ? "–" : avg.toFixed(2)}</p>
            </div>
            <Button
              className="h-14 flex-1 text-base font-semibold"
              onClick={() => setConfirm("submit")}
              disabled={busy !== null || missing.length > 0}
            >
              {busy === "submit" ? <Loader2 className="animate-spin" /> : <Send />}
              {missing.length > 0 ? `Còn ${missing.length} tiêu chí chưa chấm` : "Nộp đánh giá & Kết thúc"}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "submit" ? "Nộp đánh giá và kết thúc?" : "Trả thí sinh về phòng chờ?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "submit"
                ? `Điểm TB ${avg == null ? "–" : avg.toFixed(2)}/10 cho ${candidate?.full_name}. Sau khi nộp, đồng hồ dừng và bàn được giải phóng. Không thể sửa lại từ màn hình này.`
                : `${candidate?.full_name ?? "Thí sinh"} sẽ quay về hàng chờ, điểm đang chấm dở sẽ bị xoá.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">Quay lại</AlertDialogCancel>
            <AlertDialogAction
              className="h-11"
              variant={confirm === "submit" ? "default" : "destructive"}
              onClick={confirm === "submit" ? submit : returnToQueue}
            >
              {confirm === "submit" ? "Nộp & Kết thúc" : "Trả về phòng chờ"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
