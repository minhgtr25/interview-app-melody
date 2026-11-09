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
import type { Candidate, Evaluation, InterviewTable, OpsMessage, Room, RubricCriterion } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DepartmentRadio } from "@/components/department-radio";
import type { DepartmentCode } from "@/lib/departments";

type Draft = { scores: Record<string, number>; comment: string; secondDepartment: DepartmentCode | "" };

const draftKey = (candidateId: string) => `eval-draft:${candidateId}`;

function loadDraft(candidateId: string): Draft {
  try {
    const raw = localStorage.getItem(draftKey(candidateId));
    if (raw) {
      const d = JSON.parse(raw) as Draft;
      if (d && typeof d === "object" && d.scores) return { scores: d.scores, comment: d.comment ?? "", secondDepartment: d.secondDepartment ?? "" };
    }
  } catch {
    /* storage bị chặn */
  }
  return { scores: {}, comment: "", secondDepartment: "" };
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
  initialEvaluations,
  rooms,
  rubric,
  interviewerName,
  selfId,
}: {
  tableId: string;
  initialTables: InterviewTable[];
  initialCandidates: Candidate[];
  initialEvaluations: Evaluation[];
  rooms: Room[];
  rubric: RubricCriterion[];
  interviewerName: string;
  selfId: string;
}) {
  const tbl = useRealtimeRows<InterviewTable>("tables", initialTables, "sort_order");
  const roomRows = useRealtimeRows<Room>("rooms", rooms, "sort_order");
  const cand = useRealtimeRows<Candidate>("candidates", initialCandidates);
  const evals = useRealtimeRows<Evaluation>("evaluations", initialEvaluations);
  const patchTable = tbl.patchRow;
  const setCandidates = cand.setRows;
  const table = tbl.rows.find((t) => t.id === tableId);
  const room = roomRows.rows.find((r) => r.id === table?.room_id);
  const candidate = table?.current_candidate_id
    ? cand.rows.find((c) => c.id === table.current_candidate_id)
    : undefined;
  const candidateEvaluation = candidate ? evals.rows.find((evaluation) => evaluation.candidate_id === candidate.id) : undefined;
  const challengeQueue = useMemo(() => cand.rows
    .filter((item) => item.challenge_status === "WAITING" && item.department === table?.department)
    .sort((a, b) => (a.checked_in_at ?? "").localeCompare(b.checked_in_at ?? "")), [cand.rows, table?.department]);
  const completedAtTable = useMemo(() => evals.rows
    .filter((evaluation) => evaluation.table_id === tableId)
    .map((evaluation) => ({ evaluation, candidate: cand.rows.find((item) => item.id === evaluation.candidate_id) }))
    .filter((row) => row.candidate && (row.candidate.challenge_table_id || row.candidate.challenge_status))
    .sort((a, b) => (b.evaluation.ended_at ?? "").localeCompare(a.evaluation.ended_at ?? "")), [evals.rows, cand.rows, tableId]);

  const status = tbl.status === "live" && cand.status === "live" ? "live" : tbl.status === "offline" || cand.status === "offline" ? "offline" : "connecting";

  const [draft, setDraft] = useState<Draft>({ scores: {}, comment: "", secondDepartment: "" });
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
    setDraft(candId ? loadDraft(candId) : { scores: {}, comment: "", secondDepartment: "" });
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
    if (candidate) cand.patchRow(candidate.id, { status: "INTERVIEWING", challenge_status: room?.is_challenge ? "INTERVIEWING" : candidate.challenge_status, interview_started_at: now });
    toast.success("Bắt đầu phỏng vấn");
  }

  async function takeChallenge(candidateId: string) {
    setBusy("start");
    const { error } = await createClient().rpc("assign_challenge_candidate", { p_candidate_id: candidateId, p_table_id: tableId });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    await Promise.all([cand.refetch(), tbl.refetch(), evals.refetch()]);
    toast.success("Đã nhận thí sinh thử thách");
  }

  async function submit() {
    setConfirm(null);
    if (!candidate) return;
    setBusy("submit");
    const client = createClient();
    let { error } = room?.is_challenge
      ? await client.rpc("submit_challenge_evaluation", { p_table_id: tableId, p_scores: draft.scores, p_comment: draft.comment })
      : await client.rpc("submit_evaluation_with_referral", {
      p_table_id: tableId,
      p_scores: draft.scores,
      p_comment: draft.comment,
      p_second_department: candidate.department === "CM" && table?.department === "CM" ? draft.secondDepartment || null : null,
    });
    if (error?.code === "PGRST202" && !draft.secondDepartment && !room?.is_challenge) {
      ({ error } = await client.rpc("submit_evaluation", {
        p_table_id: tableId, p_scores: draft.scores, p_comment: draft.comment,
      }));
    }
    setBusy(null);
    if (error) return toast.error(error.code === "PGRST202" ? `Database chưa cập nhật RPC ${room?.is_challenge ? "thử thách" : "Ban thứ hai"}. Chạy các migration mới nhất.` : errorMessage(error));
    clearDraft(candidate.id);
    tbl.patchRow(tableId, { status: "AVAILABLE", current_candidate_id: null, assigned_at: null, started_at: null });
    const sendsToChallenge = !room?.is_challenge && ["VH", "HCTC"].includes(candidate.department ?? "");
    const finalStatus = room?.is_challenge || !sendsToChallenge ? "COMPLETED" : "CHECKED_IN";
    cand.patchRow(candidate.id, { status: finalStatus, challenge_status: room?.is_challenge ? "COMPLETED" : sendsToChallenge ? "WAITING" : null, interview_ended_at: room?.is_challenge || !sendsToChallenge ? new Date().toISOString() : candidate.interview_ended_at });
    void evals.refetch();
    toast.success(room?.is_challenge ? `Đã hoàn tất thử thách cho ${candidate.full_name}` : sendsToChallenge ? `Đã chuyển ${candidate.full_name} sang hàng chờ thử thách` : draft.secondDepartment ? `Đã nộp đánh giá và chuyển nguyện vọng ${draft.secondDepartment} cho Điều phối` : `Đã nộp đánh giá cho ${candidate.full_name}`);
  }

  async function returnToQueue() {
    setConfirm(null);
    setBusy("return");
    const { error } = await createClient().rpc("return_to_queue", { p_table_id: tableId });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    if (candidate) clearDraft(candidate.id);
    tbl.patchRow(tableId, { status: "AVAILABLE", current_candidate_id: null, assigned_at: null, started_at: null });
    if (candidate) cand.patchRow(candidate.id, room?.is_challenge
      ? { status: "CHECKED_IN", challenge_status: "WAITING", challenge_table_id: null, assigned_at: null, interview_started_at: null }
      : { status: "CHECKED_IN", table_id: null, assigned_at: null, interview_started_at: null });
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

        {!room?.is_challenge && completedAtTable.length > 0 && (
          <aside className="mb-5 rounded-xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/30">
            <h2 className="mb-2 font-semibold">Thí sinh đã chuyển sang thử thách</h2>
            <ul className="space-y-2">
              {completedAtTable.slice(0, 5).map(({ evaluation, candidate: item }) => item && <li key={item.id} className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2 text-sm">
                <span className="min-w-0 truncate font-medium">{item.full_name} · {evaluation.table_label}</span>
                <span className="shrink-0 text-violet-700 dark:text-violet-300">{item.challenge_status === "COMPLETED" ? "Đã hoàn tất" : item.challenge_status === "INTERVIEWING" ? "Đang thử thách" : item.challenge_status === "ASSIGNED" ? "Đã nhận" : "Chờ thử thách"}</span>
              </li>)}
            </ul>
          </aside>
        )}

        {room?.is_challenge && table?.status === "AVAILABLE" && (
          <section className="mb-5 rounded-2xl border border-violet-300 bg-violet-50 p-5 dark:border-violet-900 dark:bg-violet-950/30">
            <h2 className="text-lg font-semibold">Hàng chờ thử thách · {table.department}</h2>
            <p className="mb-4 text-sm text-muted-foreground">Chọn thí sinh đã hoàn thành vòng phỏng vấn thường. Phiếu chấm và nhận xét vòng đầu sẽ được giữ nguyên.</p>
            {challengeQueue.length ? <ul className="space-y-2">
              {challengeQueue.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background p-3">
                <div className="min-w-0"><p className="truncate font-semibold">{item.full_name}</p><p className="font-mono text-xs text-muted-foreground">{item.code} · {item.shift ?? "Không có ca"}</p></div>
                <Button onClick={() => void takeChallenge(item.id)} disabled={busy !== null}><CheckCircle2 /> Nhận thí sinh</Button>
              </li>)}
            </ul> : <p className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">Chưa có thí sinh chờ thử thách.</p>}
          </section>
        )}

        {/* Trống */}
        {table?.status === "AVAILABLE" && !room?.is_challenge && (
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
            <p className="mt-1 font-mono text-sm text-muted-foreground">{candidate.code}{candidate.student_number && ` · MSSV ${candidate.student_number}`}</p>
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
                  <p className="font-mono text-sm text-muted-foreground">{candidate.code}{candidate.student_number && ` · MSSV ${candidate.student_number}`}</p>
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
              {room?.is_challenge && candidateEvaluation && (
                <section className="rounded-2xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
                  <h2 className="font-semibold">Phiếu vòng phỏng vấn thường · chỉ xem</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{candidateEvaluation.interviewer_name} · {candidateEvaluation.table_label}</p>
                  <ul className="mt-3 divide-y rounded-lg border bg-background">
                    {rubric.map((criterion) => <li key={criterion.id} className="flex justify-between gap-3 px-3 py-2 text-sm">
                      <span>{criterion.name}</span><span className="font-semibold">{candidateEvaluation.scores?.[criterion.id] ?? "—"}/{criterion.max_score}</span>
                    </li>)}
                    <li className="flex justify-between px-3 py-2 text-sm font-semibold"><span>Điểm trung bình</span><span>{candidateEvaluation.average_score ?? "—"}/10</span></li>
                  </ul>
                  <p className="mt-3 whitespace-pre-wrap rounded-lg bg-background p-3 text-sm">{candidateEvaluation.comment || "Không có nhận xét"}</p>
                </section>
              )}
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
                  {room?.is_challenge ? "Nhận xét thử thách" : "Nhận xét"}
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
              {candidate.department === "CM" && table.department === "CM" && !candidate.source_candidate_id && (
                <div className="rounded-2xl border bg-card p-4">
                  <p className="mb-1 font-semibold">Nguyện vọng phỏng vấn Ban thứ hai</p>
                  <p className="mb-3 text-sm text-muted-foreground">Chỉ chọn khi thí sinh Chuyên Môn muốn phỏng vấn thêm nếu không đỗ Chuyên Môn. Sau khi nộp, thí sinh sẽ xuất hiện ở hàng chờ Điều phối của Ban đã chọn.</p>
                  <DepartmentRadio name={`second-department-${candidate.id}`} value={draft.secondDepartment}
                    onChange={(value) => update({ secondDepartment: value })} allowAll noneLabel="Không có Ban thứ hai" exclude="CM" />
                </div>
              )}
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
