"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { toast } from "sonner";
import {
  BellRing, CheckCircle2, ExternalLink, GripVertical, Loader2, Minus, Plus, Send, Undo2, Coffee, Mail, Phone, Timer, Megaphone, MessageCircle, PanelRightClose, PanelRightOpen, Pause, Play, ShieldAlert,
} from "lucide-react";
import { useOpsChannel } from "@/hooks/use-ops-channel";
import { AppHeader } from "@/components/app-header";
import { Elapsed, useServerNow } from "@/components/clock";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OpsChat } from "@/components/ops-chat";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useRealtimeRows } from "@/hooks/use-realtime-rows";
import { createClient, prepareRealtime } from "@/lib/supabase/client";
import { errorMessage, safeUrl } from "@/lib/format";
import type { Candidate, DebateJudgeReview, Evaluation, InterviewTable, OpsMessage, Profile, Room, RubricCriterion } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DepartmentRadio } from "@/components/department-radio";
import type { DepartmentCode } from "@/lib/departments";
import { SPECIALIZATIONS_BY_DEPARTMENT, specializationLabel, type SpecializationCode } from "@/lib/specializations";
import { ScheduleFields, isFutureInterviewSlot } from "@/components/schedule-fields";
import { makeInterviewShift } from "@/lib/interview-days";
import { useInterviewDayAutoSwitch } from "@/hooks/use-interview-day-auto-switch";

type Draft = { scores: Record<string, number>; comment: string; secondDepartment: DepartmentCode | ""; secondSpecialization: SpecializationCode | ""; secondDate: string; secondTime: string };

const draftKey = (candidateId: string) => `eval-draft:${candidateId}`;

function loadDraft(candidateId: string): Draft {
  try {
    const raw = localStorage.getItem(draftKey(candidateId));
    if (raw) {
      const d = JSON.parse(raw) as Draft;
      if (d && typeof d === "object" && d.scores) return { scores: d.scores, comment: d.comment ?? "", secondDepartment: d.secondDepartment ?? "", secondSpecialization: d.secondSpecialization ?? "", secondDate: d.secondDate ?? "", secondTime: d.secondTime ?? "" };
    }
  } catch {
    /* storage bị chặn */
  }
  return { scores: {}, comment: "", secondDepartment: "", secondSpecialization: "", secondDate: "", secondTime: "" };
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
  initialDebateReviews,
  debateJudgePosition,
  debateJudgeCount,
  rooms,
  rubric,
  interviewerName,
  selfId,
  activeDay,
  adminPreview = false,
  actingJudgeId,
  previewJudges = [],
}: {
  tableId: string;
  initialTables: InterviewTable[];
  initialCandidates: Candidate[];
  initialEvaluations: Evaluation[];
  initialDebateReviews: DebateJudgeReview[];
  debateJudgePosition: 1 | 2 | null;
  debateJudgeCount: number;
  rooms: Room[];
  rubric: RubricCriterion[];
  interviewerName: string;
  selfId: string;
  activeDay: string | null;
  adminPreview?: boolean;
  actingJudgeId?: string;
  previewJudges?: Profile[];
}) {
  useInterviewDayAutoSwitch(activeDay);
  const tbl = useRealtimeRows<InterviewTable>("tables", initialTables, "sort_order");
  const roomRows = useRealtimeRows<Room>("rooms", rooms, "sort_order");
  const cand = useRealtimeRows<Candidate>("candidates", initialCandidates);
  const evals = useRealtimeRows<Evaluation>("evaluations", initialEvaluations);
  const debateReviews = useRealtimeRows<DebateJudgeReview>("debate_judge_reviews", initialDebateReviews, "updated_at");
  const [selectedDebateCandidateId, setSelectedDebateCandidateId] = useState<string | null>(null);
  const [dragDebateCandidateId, setDragDebateCandidateId] = useState<string | null>(null);
  const [dragOverDeskId, setDragOverDeskId] = useState<string | null>(null);
  const patchTable = tbl.patchRow;
  const setCandidates = cand.setRows;
  const table = tbl.rows.find((t) => t.id === tableId);
  const room = roomRows.rows.find((r) => r.id === table?.room_id);
  const anchorCandidate = table?.current_candidate_id
    ? cand.rows.find((c) => c.id === table.current_candidate_id)
    : undefined;
  const activeDebatePair = room?.is_challenge && anchorCandidate ? cand.rows.filter((item) =>
    item.challenge_table_id === tableId && item.debate_batch_number === anchorCandidate.debate_batch_number &&
    item.challenge_status !== "WAITING").sort((a, b) => (a.debate_slot_number ?? 0) - (b.debate_slot_number ?? 0)) : [];
  const candidate = room?.is_challenge
    ? activeDebatePair.find((item) => item.id === selectedDebateCandidateId && item.challenge_status !== "COMPLETED") ??
      activeDebatePair.find((item) => item.debate_slot_number === debateJudgePosition && item.challenge_status !== "COMPLETED") ??
      activeDebatePair.find((item) => item.challenge_status !== "COMPLETED") ?? anchorCandidate
    : anchorCandidate;
  const effectiveJudgeId = actingJudgeId ?? selfId;
  const candidateEvaluation = candidate ? evals.rows.find((evaluation) => evaluation.candidate_id === candidate.id) : undefined;
  const continuingVhReview = candidate?.department === "VH" && !candidate.challenge_status &&
    candidateEvaluation?.table_id === tableId && !!room?.external_challenge;
  const candidateDebateReviews = candidate ? debateReviews.rows.filter((review) => review.candidate_id === candidate.id && review.table_id === tableId) : [];
  const myDebateReview = candidateDebateReviews.find((review) => review.judge_id === effectiveJudgeId);
  const confirmedDebateComment = myDebateReview?.comment;
  const allDebateJudgesConfirmed = activeDebatePair.length >= 1 && activeDebatePair.length <= 2 && activeDebatePair.every((item) =>
    item.challenge_status === "COMPLETED" || debateReviews.rows.some((review) => review.candidate_id === item.id &&
      review.table_id === tableId && review.judge_position === (activeDebatePair.length === 1 || debateJudgeCount === 1 ? 1 : item.debate_slot_number)));
  const canDirectDebate = debateJudgePosition === 1;
  const canScoreDebateCandidate = !!candidate && (!room?.is_challenge ||
    (activeDebatePair.length === 1 ? debateJudgePosition === 1 : debateJudgeCount === 1 || candidate.debate_slot_number === debateJudgePosition));
  const pendingDebateRequests = cand.rows.filter((item) => item.department === "HCTC" &&
    item.challenge_status === "WAITING" && item.debate_request_status === "PENDING" &&
    item.challenge_table_id === tableId).sort((a, b) => (a.challenge_started_at ?? "").localeCompare(b.challenge_started_at ?? ""));
  const pendingDebateIds = pendingDebateRequests.map((item) => item.id).join(",");
  const seenPendingDebateIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const next = new Set(pendingDebateIds ? pendingDebateIds.split(",") : []);
    if (seenPendingDebateIds.current && [...next].some((id) => !seenPendingDebateIds.current?.has(id))) {
      toast.info("Có yêu cầu mới gửi đến bàn Debate", { duration: 6000 });
    }
    seenPendingDebateIds.current = next;
  }, [pendingDebateIds]);
  const sharedDebateQueue = cand.rows.filter((item) => item.department === "HCTC" &&
    item.challenge_status === "WAITING" && item.debate_request_status === "WAITING")
    .sort((a, b) => (a.challenge_started_at ?? "").localeCompare(b.challenge_started_at ?? ""));
  const visibleDebateChatIds = [...pendingDebateRequests, ...sharedDebateQueue, ...activeDebatePair].map((item) => item.id).join(",");
  const debatePeer = tbl.rows.find((desk) => desk.room_id === table?.room_id && desk.id !== tableId);
  const hasDebateSlot = table?.status === "AVAILABLE" || (table?.status === "ASSIGNED" && activeDebatePair.length === 1);
  const debateTables = tbl.rows.filter((desk) => desk.department === "HCTC" &&
    roomRows.rows.some((targetRoom) => targetRoom.id === desk.room_id && targetRoom.is_challenge && targetRoom.is_configured));
  const completedAtTable = useMemo(() => evals.rows
    .filter((evaluation) => evaluation.table_id === tableId)
    .map((evaluation) => ({ evaluation, candidate: cand.rows.find((item) => item.id === evaluation.candidate_id) }))
    .filter((row) => row.candidate && (row.candidate.challenge_table_id || row.candidate.challenge_status))
    .sort((a, b) => (b.evaluation.ended_at ?? "").localeCompare(a.evaluation.ended_at ?? "")), [evals.rows, cand.rows, tableId]);

  const status = tbl.status === "live" && cand.status === "live" ? "live" : tbl.status === "offline" || cand.status === "offline" ? "offline" : "connecting";

  const [draft, setDraft] = useState<Draft>({ scores: {}, comment: "", secondDepartment: "", secondSpecialization: "", secondDate: "", secondTime: "" });
  const serverNow = useServerNow(30_000);
  const [busy, setBusy] = useState<"start" | "submit" | "return" | "pause" | "force" | null>(null);
  const [adminForceOpen, setAdminForceOpen] = useState(false);
  const [adminForceNote, setAdminForceNote] = useState("");
  const [confirm, setConfirm] = useState<"submit" | "return" | null>(null);
  const [debateTableId, setDebateTableId] = useState("");
  const [roundTwoOpen, setRoundTwoOpen] = useState(true);
  const [finishExternal, setFinishExternal] = useState<Candidate | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatCandidateId, setChatCandidateId] = useState<string | undefined>();
  const [chatUnread, setChatUnread] = useState(false);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  function openChat(candidateThreadId?: string) { setChatUnread(false); setChatCandidateId(candidateThreadId); setChatOpen(true); }

  useEffect(() => {
    const client = createClient();
    let active = true;
    let channel: RealtimeChannel | null = null;
    void prepareRealtime().then(() => {
      if (!active) return;
      channel = client.channel(`interviewer-chat:${tableId}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ops_messages" },
        (payload: RealtimePostgresChangesPayload<OpsMessage>) => {
          const message = payload.new as OpsMessage;
          const candidateThread = !!message.candidate_id && (completedAtTable.some(({ candidate: item }) => item?.id === message.candidate_id) || candidate?.id === message.candidate_id || visibleDebateChatIds.split(",").includes(message.candidate_id));
          if ((message.table_id !== tableId && !candidateThread) || message.kind !== "CHAT" || message.sender_id === selfId || chatOpenRef.current) return;
          setChatUnread(true);
          toast.info(message.candidate_id ? "Giám khảo bàn liên quan gửi tin nhắn" : "Điều phối gửi tin nhắn", {
            description: message.body,
            duration: 10000,
            action: { label: "Mở chat", onClick: () => openChat(message.candidate_id ?? undefined) },
          });
        })
      .subscribe();
    }).catch(() => { /* chat dialog can still load messages over REST */ });
    return () => { active = false; if (channel) void client.removeChannel(channel); };
  }, [tableId, selfId, completedAtTable, candidate?.id, visibleDebateChatIds]);

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
  const draftId = candId && room?.is_challenge ? `${candId}:${effectiveJudgeId}` : candId;
  useEffect(() => {
    const saved = draftId ? loadDraft(draftId) : { scores: {}, comment: "", secondDepartment: "" as const, secondSpecialization: "" as const, secondDate: "", secondTime: "" };
    const previousReview = continuingVhReview && candidateEvaluation
      ? { ...saved, scores: { ...candidateEvaluation.scores, ...saved.scores }, comment: saved.comment || candidateEvaluation.comment || "" }
      : saved;
    setDraft(confirmedDebateComment === undefined ? previousReview : { ...previousReview, comment: confirmedDebateComment });
  }, [draftId, confirmedDebateComment, continuingVhReview, candidateEvaluation]);

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
       if (draftId) saveDraft(draftId, next);
      return next;
    });
  }

  const missing = useMemo(() => room?.is_challenge ? [] : rubric.filter((r) => draft.scores[r.id] == null), [rubric, draft.scores, room?.is_challenge]);
  const myDebateReviewNeedsUpdate = !!myDebateReview && (draft.comment.trim() !== myDebateReview.comment);
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
    const { error } = await createClient().rpc(room?.is_challenge ? "start_debate_pair" : "start_interview", { p_table_id: tableId });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    if (room?.is_challenge) { await Promise.all([tbl.refetch(), cand.refetch()]); toast.success("Đã bắt đầu ca Debate"); return; }
    const now = new Date().toISOString();
    tbl.patchRow(tableId, { status: "INTERVIEWING", started_at: now });
    if (candidate) cand.patchRow(candidate.id, { status: "INTERVIEWING", challenge_status: room?.is_challenge ? "INTERVIEWING" : candidate.challenge_status, interview_started_at: now });
    toast.success("Bắt đầu phỏng vấn");
  }

  async function handleDebateRequest(candidateId: string, action: "ACCEPT" | "FORWARD" | "WAIT" | "REJECT") {
    setBusy("start");
    const { error } = await createClient().rpc("handle_debate_request", {
      p_candidate_id: candidateId, p_table_id: tableId, p_action: action,
    });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    await Promise.all([cand.refetch(), tbl.refetch(), evals.refetch()]);
    toast.success(action === "ACCEPT" ? "Đã đưa thí sinh vào bàn" : action === "FORWARD" ? `Đã gửi yêu cầu sang ${debatePeer?.name ?? "bàn kia"}` : action === "REJECT" ? "Đã từ chối; thí sinh về hàng chờ" : "Đã đưa thí sinh vào hàng chờ chung");
  }

  async function routeDebateRequest(candidateId: string) {
    if (!debatePeer) return;
    setBusy("start");
    const { error } = await createClient().rpc("route_debate_request", {
      p_candidate_id: candidateId, p_from_table_id: tableId,
    });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    await cand.refetch();
    toast.success(`Đã gửi yêu cầu sang ${debatePeer.name}`);
  }

  function debateDropAction(item: Candidate, targetId: string) {
    if (!canDirectDebate || busy || item.challenge_status !== "WAITING") return;
    if (targetId === tableId) {
      if (hasDebateSlot && (item.debate_request_status === "WAITING" || item.challenge_table_id === tableId))
        void handleDebateRequest(item.id, "ACCEPT");
    } else if (targetId === debatePeer?.id) {
      if (item.debate_request_status === "WAITING") void routeDebateRequest(item.id);
      else if (item.debate_request_status === "PENDING" && item.challenge_table_id === tableId)
        void handleDebateRequest(item.id, "FORWARD");
    }
  }

  async function finishExternalChallenge(candidateToFinish: Candidate) {
    setFinishExternal(null);
    setBusy("submit");
    const { error } = await createClient().rpc("finish_external_challenge", { p_candidate_id: candidateToFinish.id });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    const finishedAt = new Date().toISOString();
    cand.patchRow(candidateToFinish.id, { status: "COMPLETED", challenge_status: "COMPLETED", interview_ended_at: finishedAt });
    toast.success(`Đã xác nhận hoàn tất phỏng vấn ${candidateToFinish.full_name}`);
  }

  async function continueVhReview(candidateToContinue: Candidate) {
    setBusy("start");
    const { error } = await createClient().rpc("continue_vh_review", { p_candidate_id: candidateToContinue.id });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    await Promise.all([tbl.refetch(), cand.refetch(), evals.refetch()]);
    toast.success(`Đã đưa ${candidateToContinue.full_name} về bàn để tiếp tục chấm`);
  }

  const canPauseDesk = !!room && !room.is_challenge && !room.external_challenge;
  async function toggleDeskPause() {
    if (!table || busy) return;
    const paused = !table.is_paused;
    setBusy("pause");
    const { error } = await createClient().rpc("set_table_paused", { p_table_id: table.id, p_paused: paused });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    tbl.patchRow(table.id, { is_paused: paused });
    toast.success(paused ? "Bàn đã tạm dừng nhận thí sinh" : "Bàn đã mở lại tiếp nhận thí sinh");
  }

  async function submit() {
    setConfirm(null);
    if (!candidate) return;
    if (candidate.department === "HCTC" && !room?.is_challenge && !debateTables.some((desk) => desk.id === debateTableId))
      return toast.error("Chọn bàn Debate để chuyển thí sinh");
    if (candidate.department === "CM" && table?.department === "CM" &&
      (draft.secondDepartment === "CM" || draft.secondDepartment === "TT") && !draft.secondSpecialization)
      return toast.error(`Chọn ngạch ${draft.secondDepartment === "CM" ? "Chuyên Môn" : "Truyền Thông"} cho lượt tiếp theo`);
    if (candidate.department === "CM" && draft.secondDepartment === "CM" && draft.secondSpecialization === candidate.specialization)
      return toast.error("Lượt Chuyên Môn tiếp theo phải chọn ngạch khác ngạch hiện tại");
    if (draft.secondDepartment && (draft.secondDate || draft.secondTime) && !isFutureInterviewSlot(draft.secondDate, draft.secondTime, serverNow))
      return toast.error("Ca Ban thứ hai cần đủ ngày giờ chưa qua theo giờ Hà Nội");
    setBusy("submit");
    const client = createClient();
    if (room?.is_challenge && (!canScoreDebateCandidate || !draft.comment.trim())) {
      setBusy(null);
      return toast.error("Nhập nhận xét cho thí sinh được phân công trước khi xác nhận");
    }
    let { error } = room?.is_challenge
      ? adminPreview
        ? await client.rpc("admin_confirm_debate_comment", { p_table_id: tableId, p_candidate_id: candidate.id, p_judge_id: effectiveJudgeId, p_comment: draft.comment })
        : await client.rpc("confirm_debate_comment", { p_table_id: tableId, p_candidate_id: candidate.id, p_comment: draft.comment })
      : candidate.department === "HCTC"
      ? await client.rpc("submit_evaluation_to_debate", { p_table_id: tableId, p_scores: draft.scores, p_comment: draft.comment, p_debate_table_id: debateTableId })
      : await client.rpc("submit_evaluation_with_referral", {
      p_table_id: tableId,
      p_scores: draft.scores,
      p_comment: draft.comment,
      p_second_department: candidate.department === "CM" && table?.department === "CM" ? draft.secondDepartment || null : null,
      p_second_specialization: candidate.department === "CM" && table?.department === "CM" &&
        (draft.secondDepartment === "CM" || draft.secondDepartment === "TT") ? draft.secondSpecialization || null : null,
      p_second_shift: candidate.department === "CM" && table?.department === "CM" && draft.secondDepartment && draft.secondDate && draft.secondTime
        ? makeInterviewShift(draft.secondDate, draft.secondTime, draft.secondDepartment) : null,
    });
    if (error?.code === "PGRST202" && !draft.secondDepartment && !room?.is_challenge && candidate.department !== "HCTC") {
      ({ error } = await client.rpc("submit_evaluation", {
        p_table_id: tableId, p_scores: draft.scores, p_comment: draft.comment,
      }));
    }
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    if (room?.is_challenge) {
      await debateReviews.refetch();
      toast.success(`Đã xác nhận đánh giá Debate cho ${candidate.full_name}`);
      return;
    }
    clearDraft(candidate.id);
    tbl.patchRow(tableId, { status: "AVAILABLE", current_candidate_id: null, assigned_at: null, started_at: null });
    const sendsToChallenge = !room?.is_challenge && (candidate.department === "HCTC" || (candidate.department === "VH" && room?.external_challenge));
    const finalStatus = room?.is_challenge || !sendsToChallenge ? "COMPLETED" : "CHECKED_IN";
    const submittedAt = new Date().toISOString();
    cand.patchRow(candidate.id, { status: finalStatus, challenge_status: room?.is_challenge ? "COMPLETED" : sendsToChallenge ? "WAITING" : null, challenge_table_id: candidate.department === "HCTC" && sendsToChallenge ? debateTableId : candidate.challenge_table_id, debate_request_status: candidate.department === "HCTC" && sendsToChallenge ? "PENDING" : candidate.debate_request_status, challenge_started_at: sendsToChallenge ? submittedAt : candidate.challenge_started_at, interview_ended_at: room?.is_challenge || !sendsToChallenge ? submittedAt : candidate.interview_ended_at });
    void evals.refetch();
    if (candidate.department === "HCTC") void cand.refetch();
    toast.success(candidate.department === "HCTC" && sendsToChallenge
      ? `Đã gửi yêu cầu nhận ${candidate.full_name} đến ${debateTables.find((desk) => desk.id === debateTableId)?.name ?? "bàn Debate"}`
      : sendsToChallenge ? `Đã chuyển ${candidate.full_name} sang hàng chờ thử thách`
      : draft.secondDepartment ? `Đã nộp đánh giá và chuyển nguyện vọng ${draft.secondDepartment} cho Điều phối`
      : `Đã nộp đánh giá cho ${candidate.full_name}`);
  }

  async function finalizeDebateCandidate() {
    if (!candidate || !room?.is_challenge || !canDirectDebate) return;
    setBusy("submit");
    const { error } = await createClient().rpc("finalize_debate_pair", {
      p_table_id: tableId, p_judge_id: adminPreview ? effectiveJudgeId : null,
    });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    activeDebatePair.forEach((item) => clearDraft(`${item.id}:${effectiveJudgeId}`));
    await Promise.all([tbl.refetch(), cand.refetch(), evals.refetch(), debateReviews.refetch()]);
    toast.success(`Đã chốt ca Debate cho ${activeDebatePair.length} thí sinh`);
  }

  async function returnToQueue() {
    setConfirm(null);
    setBusy("return");
    const { error } = await createClient().rpc("return_to_queue", { p_table_id: tableId });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    if (room?.is_challenge) {
      activeDebatePair.forEach((item) => clearDraft(`${item.id}:${effectiveJudgeId}`));
      await Promise.all([tbl.refetch(), cand.refetch()]);
      toast.success("Đã trả ca Debate về hàng chờ");
      return;
    }
    if (candidate) clearDraft(candidate.id);
    tbl.patchRow(tableId, { status: "AVAILABLE", current_candidate_id: null, assigned_at: null, started_at: null });
    if (candidate) cand.patchRow(candidate.id, room?.is_challenge
      ? { status: "CHECKED_IN", challenge_status: "WAITING", assigned_at: null, interview_started_at: null }
      : { status: "CHECKED_IN", table_id: null, assigned_at: null, interview_started_at: null });
    toast.success("Đã trả thí sinh về phòng chờ");
  }

  async function adminForceFinish() {
    if (!adminPreview || !table || !adminForceNote.trim()) return;
    setBusy("force");
    const { error } = await createClient().rpc(room?.is_challenge ? "admin_force_finish_debate_pair" : "admin_force_finish_interview", {
      p_table_id: table.id,
      p_note: adminForceNote.trim(),
    });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    setAdminForceOpen(false);
    setAdminForceNote("");
    await Promise.all([tbl.refetch(), cand.refetch(), evals.refetch()]);
    toast.success(room?.is_challenge ? "Đã cưỡng chế kết thúc ca Debate" : "Đã cưỡng chế kết thúc và nộp phiếu điểm 10");
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

  const tableLabel = table ? `Phòng: ${room?.name ?? "—"} | ${table.name} | Ban: ${table.department ?? "Chưa chọn"}${table.specialization ? ` | Ngạch: ${specializationLabel(table.specialization)}` : ""}` : "Bàn phỏng vấn";
  const mobileTableLabel = table ? `${room?.name ?? "—"} · ${table.name} · ${table.department ?? "—"}${table.specialization ? ` · ${specializationLabel(table.specialization)}` : ""}` : "Bàn phỏng vấn";
  const cvUrl = safeUrl(candidate?.cv_url);

  return (
    <div className="min-h-dvh bg-muted/30">
      <AppHeader title={tableLabel} mobileTitle={mobileTableLabel} subtitle={interviewerName} status={status}>
        {adminPreview && <Link href="/admin/rooms" className="inline-flex h-9 shrink-0 items-center rounded-md border px-2 text-xs font-medium hover:bg-muted sm:px-3 sm:text-sm">Quản trị</Link>}
        {adminPreview && table && (table.status === "ASSIGNED" || table.status === "INTERVIEWING") && <Button variant="destructive" size="sm" className="h-9 shrink-0 px-2 sm:px-3" onClick={() => { setAdminForceNote(""); setAdminForceOpen(true); }}>
          <ShieldAlert /><span className="hidden sm:inline">Cưỡng chế kết thúc</span><span className="sm:hidden">Kết thúc</span>
        </Button>}
        {canPauseDesk && table && <Button variant={table.is_paused ? "default" : "outline"} size="sm" onClick={() => void toggleDeskPause()}
          disabled={busy !== null} aria-label={table.is_paused ? "Mở lại tiếp nhận thí sinh" : "Tạm dừng tiếp nhận thí sinh"}
          title={table.is_paused ? "Mở lại tiếp nhận" : "Tạm dừng tiếp nhận"} className="h-9 shrink-0 px-2 sm:px-3">
          {busy === "pause" ? <Loader2 className="animate-spin" /> : table.is_paused ? <Play /> : <Pause />}
          <span className="hidden sm:inline">{table.is_paused ? "Mở tiếp nhận" : "Tạm dừng"}</span>
        </Button>}
        {!room?.is_challenge && completedAtTable.length > 0 && <Button variant="outline" size="sm" onClick={() => setRoundTwoOpen((open) => !open)}
          aria-expanded={roundTwoOpen} aria-label={roundTwoOpen ? "Đóng bảng theo dõi vòng 2" : "Mở bảng theo dõi vòng 2"}>
          {roundTwoOpen ? <PanelRightClose /> : <PanelRightOpen />}<span className="hidden sm:inline">Vòng 2 · {completedAtTable.length}</span>
        </Button>}
        <Button variant="outline" size="sm" onClick={() => openChat()} aria-label="Chat với điều phối" title="Chat với điều phối" className="relative h-9 shrink-0 px-2 sm:px-3">
          <MessageCircle /><span className="hidden sm:inline">Chat</span>
          {chatUnread && <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-red-500" />}
        </Button>
        <Button variant="outline" size="sm" onClick={callCoordinator}
          disabled={!table || callBusy || callWait > 0}
          aria-label={callWait > 0 ? `Gọi lại điều phối sau ${callWait} giây` : "Gọi điều phối viên"}
          title={callWait > 0 ? `Gọi lại sau ${callWait} giây` : "Gọi điều phối viên"} className="h-9 shrink-0 px-2 sm:px-3">
          <Megaphone />
          <span className="hidden sm:inline">{callWait > 0 ? `Gọi lại ${callWait}s` : "Gọi điều phối"}</span>
        </Button>
        {table?.status === "INTERVIEWING" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-red-600 px-2 py-1.5 font-mono text-sm font-semibold text-white tabular-nums sm:gap-1.5 sm:px-3 sm:text-lg">
            <Timer className="size-3.5 sm:size-4" />
            <Elapsed since={table.started_at} />
          </span>
        )}
      </AppHeader>

      {adminPreview && <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-950 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100 sm:text-sm">
        Đang mở bàn bằng quyền Admin. Các thao tác tại đây sẽ cập nhật dữ liệu thật.
      </div>}
      {adminPreview && room?.is_challenge && <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2 text-sm">
        <span className="font-medium">Tài khoản tại {table?.name}:</span>
        {previewJudges.map((judge) => <Link key={judge.id} href={`/admin-preview/${tableId}?judgeId=${judge.id}`}
          className={cn("rounded-md border px-3 py-1.5", actingJudgeId === judge.id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
          GK {judge.debate_judge_position} · {judge.full_name || judge.email}
        </Link>)}
      </div>}

      <Dialog open={chatOpen} onOpenChange={setChatOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{chatCandidateId ? (() => {
            const threadCandidate = cand.rows.find((item) => item.id === chatCandidateId);
            const peerTableId = room?.is_challenge ? threadCandidate?.table_id : threadCandidate?.challenge_table_id;
            const peerTable = tbl.rows.find((item) => item.id === peerTableId);
            return `Chat với Giám khảo · ${roomRows.rows.find((item) => item.id === peerTable?.room_id)?.name ?? "Phòng Debate"} - ${peerTable?.name ?? "bàn liên quan"}`;
          })() : `Chat với điều phối · ${room?.name} - ${table?.name}`}</DialogTitle></DialogHeader>
          <OpsChat tableId={tableId} selfId={selfId} role="interviewer" candidateId={chatCandidateId} />
        </DialogContent>
      </Dialog>

      <Dialog open={adminForceOpen} onOpenChange={(open) => { if (busy !== "force") setAdminForceOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cưỡng chế kết thúc lượt phỏng vấn?</DialogTitle>
            <DialogDescription>
              {room?.is_challenge ? "Cả ca Debate sẽ được lưu ghi chú Admin và giải phóng bàn." : `${candidate?.full_name ?? "Thí sinh tại bàn"} sẽ được nộp phiếu điểm 10, ghi chú Admin và giải phóng bàn.`}
              {table?.status === "ASSIGNED" ? " Thí sinh đang chờ giám khảo xác nhận bắt đầu." : ""}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={adminForceNote} onChange={(event) => setAdminForceNote(event.target.value)} maxLength={2000}
            placeholder="Ví dụ: do quá giờ" aria-label="Lý do cưỡng chế kết thúc" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdminForceOpen(false)} disabled={busy === "force"}>Huỷ</Button>
            <Button variant="destructive" onClick={() => void adminForceFinish()} disabled={busy === "force" || !adminForceNote.trim()}>
              {busy === "force" ? <Loader2 className="animate-spin" /> : <ShieldAlert />} {room?.is_challenge ? "Kết thúc ca Debate" : "Kết thúc và nộp điểm 10"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <main className={cn("mx-auto grid w-full items-start gap-5 px-3 py-4 pb-32 sm:px-4 sm:py-5",
        room?.is_challenge ? "max-w-7xl" : "max-w-6xl",
        !room?.is_challenge && completedAtTable.length > 0 && roundTwoOpen && "lg:grid-cols-[minmax(0,1fr)_340px]")}>
        <div className="min-w-0">
        {!table && <p className="py-16 text-center text-muted-foreground">Không tìm thấy bàn được phân công.</p>}

        {room?.is_challenge && (
          <div className="mb-5 space-y-4">
            <section className="rounded-2xl border bg-card p-4 sm:p-5">
              <h2 className="text-lg font-semibold">Phòng Debate · kéo thí sinh vào bàn</h2>
              <p className="mt-1 text-sm text-muted-foreground">GK 1 kéo thí sinh từ yêu cầu hoặc hàng chờ vào bàn của mình. Kéo sang bàn còn lại sẽ gửi yêu cầu để GK 1 bàn đó đồng ý hoặc từ chối.</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[table, debatePeer].filter((desk): desk is InterviewTable => !!desk).map((desk) => {
                  const anchor = cand.rows.find((item) => item.id === desk.current_candidate_id);
                  const pair = anchor ? cand.rows.filter((item) => item.challenge_table_id === desk.id && item.debate_batch_number === anchor.debate_batch_number && item.debate_request_status === "SLOT")
                    .sort((a, b) => (a.debate_slot_number ?? 0) - (b.debate_slot_number ?? 0)) : [];
                  const ownDesk = desk.id === tableId;
                  const dragged = cand.rows.find((item) => item.id === dragDebateCandidateId);
                  const canDrop = canDirectDebate && !!dragged && (ownDesk
                    ? hasDebateSlot && (dragged.debate_request_status === "WAITING" || (dragged.debate_request_status === "PENDING" && dragged.challenge_table_id === tableId))
                    : dragged.debate_request_status === "WAITING" || (dragged.debate_request_status === "PENDING" && dragged.challenge_table_id === tableId));
                  return <div key={desk.id} onDragOver={(event) => {
                      if (!canDrop) return;
                      event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverDeskId(desk.id);
                    }} onDragLeave={() => setDragOverDeskId((id) => id === desk.id ? null : id)}
                    onDrop={(event) => {
                      event.preventDefault(); setDragOverDeskId(null);
                      const item = cand.rows.find((row) => row.id === event.dataTransfer.getData("text/plain"));
                      if (item && canDrop) debateDropAction(item, desk.id);
                    }}
                    className={cn("rounded-xl border-2 border-dashed p-3 transition-colors", ownDesk ? "border-violet-400 bg-violet-50/50 dark:bg-violet-950/20" : "border-slate-300", dragOverDeskId === desk.id && canDrop && "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30")}>
                    <div className="flex items-center justify-between gap-2"><p className="font-semibold">{desk.name} {ownDesk ? "· Bàn của bạn" : "· Bàn bên cạnh"}</p>
                      <span className="text-xs text-muted-foreground">{desk.status === "AVAILABLE" ? "Trống" : desk.status === "ASSIGNED" ? "Chờ bắt đầu" : "Đang Debate"}</span></div>
                    <div className="mt-3 grid gap-2">
                      {[1, 2].map((slot) => {
                        const occupant = pair.find((item) => item.debate_slot_number === slot);
                        return <div key={slot} className="rounded-lg border bg-background px-3 py-2 text-sm">
                          <span className="mr-2 text-xs font-semibold text-muted-foreground">Vị trí {slot}</span>
                          {occupant ? <span className="font-medium">{occupant.full_name} · {occupant.code}</span> : <span className="text-muted-foreground">Đang trống</span>}
                        </div>;
                      })}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">{ownDesk ? "Thả vào đây để nhận thí sinh" : "Thả vào đây để gửi yêu cầu chuyển bàn"}</p>
                  </div>;
                })}
              </div>
            </section>
            <section className="rounded-2xl border border-violet-300 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/30 sm:p-5">
              <h2 className="text-lg font-semibold">Yêu cầu gửi đến {table?.name}</h2>
              <p className="mb-4 text-sm text-muted-foreground">{canDirectDebate ? `Giám khảo 1 quyết định nhận vào vị trí trống, chuyển sang ${debatePeer?.name ?? "bàn kia"}, hoặc đưa vào hàng chờ chung.` : "Giám khảo 1 của bàn sẽ xử lý các yêu cầu này."}</p>
              {pendingDebateRequests.length ? <ul className="space-y-3">{pendingDebateRequests.map((item) =>
                <li key={item.id} draggable={canDirectDebate} onDragStart={(event) => { event.dataTransfer.setData("text/plain", item.id); setDragDebateCandidateId(item.id); }} onDragEnd={() => { setDragDebateCandidateId(null); setDragOverDeskId(null); }}
                  className={cn("rounded-xl border bg-background p-3", canDirectDebate && "cursor-grab active:cursor-grabbing")}>
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div className="flex items-start gap-2">{canDirectDebate && <GripVertical className="mt-1 size-4 text-muted-foreground" />}<div><p className="font-semibold">{item.full_name}</p><p className="font-mono text-xs text-muted-foreground">{item.code} · {item.shift ?? "Không có ca"}</p></div></div>
                    <span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-medium text-violet-800">
                      {item.debate_requested_from_table_id ? `Chuyển từ ${tbl.rows.find((desk) => desk.id === item.debate_requested_from_table_id)?.name ?? "bàn kia"}` : "Từ vòng phỏng vấn"}
                    </span>
                  </div>
                  {evals.rows.find((evaluation) => evaluation.candidate_id === item.id) && <div className="mb-3 rounded-lg border bg-muted/40 p-3 text-sm">
                    <p className="font-medium">Nhận xét vòng 1 · {evals.rows.find((evaluation) => evaluation.candidate_id === item.id)?.average_score ?? "—"}/10</p>
                    <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{evals.rows.find((evaluation) => evaluation.candidate_id === item.id)?.comment || "Không có nhận xét"}</p>
                  </div>}
                  {canDirectDebate && <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void handleDebateRequest(item.id, "ACCEPT")} disabled={busy !== null || !hasDebateSlot}>
                      <CheckCircle2 /> {hasDebateSlot ? `Đồng ý · vị trí ${table?.status === "AVAILABLE" ? 1 : 2}` : "Bàn đã đủ người"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void handleDebateRequest(item.id, "FORWARD")} disabled={busy !== null || !debatePeer}>Chuyển sang {debatePeer?.name ?? "bàn kia"}</Button>
                    <Button size="sm" variant="outline" onClick={() => void handleDebateRequest(item.id, "WAIT")} disabled={busy !== null}>Đưa vào danh sách chờ</Button>
                    {item.debate_requested_from_table_id && <Button size="sm" variant="destructive" onClick={() => void handleDebateRequest(item.id, "REJECT")} disabled={busy !== null}>Từ chối chuyển bàn</Button>}
                  </div>}
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => openChat(item.id)}><MessageCircle /> Chat với Giám khảo phỏng vấn</Button>
                </li>)}</ul> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Chưa có yêu cầu mới.</p>}
            </section>
            <section className="rounded-2xl border bg-card p-4 sm:p-5">
              <h2 className="text-lg font-semibold">Danh sách chờ chung · {sharedDebateQueue.length}</h2>
              <p className="mb-4 text-sm text-muted-foreground">Cả hai giám khảo Debate đều thấy danh sách này. Mỗi giám khảo tự chọn người vào bàn của mình.</p>
              {sharedDebateQueue.length ? <ul className="space-y-2">{sharedDebateQueue.map((item) =>
                <li key={item.id} draggable={canDirectDebate} onDragStart={(event) => { event.dataTransfer.setData("text/plain", item.id); setDragDebateCandidateId(item.id); }} onDragEnd={() => { setDragDebateCandidateId(null); setDragOverDeskId(null); }}
                  className={cn("flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3", canDirectDebate && "cursor-grab active:cursor-grabbing")}>
                  <div><p className="font-semibold">{item.full_name}</p><p className="font-mono text-xs text-muted-foreground">{item.code} · Chờ <Elapsed since={item.challenge_started_at} /></p>
                    <p className="mt-1 text-xs text-muted-foreground">Vòng 1: {evals.rows.find((evaluation) => evaluation.candidate_id === item.id)?.average_score ?? "—"}/10 · {evals.rows.find((evaluation) => evaluation.candidate_id === item.id)?.comment || "Không có nhận xét"}</p></div>
                  {canDirectDebate && <Button size="sm" onClick={() => void handleDebateRequest(item.id, "ACCEPT")} disabled={busy !== null || !hasDebateSlot}>
                    Đưa vào {table?.name} · vị trí {table?.status === "AVAILABLE" ? 1 : 2}
                  </Button>}
                  {canDirectDebate && debatePeer && <Button size="sm" variant="outline" onClick={() => void routeDebateRequest(item.id)} disabled={busy !== null}>Gửi sang {debatePeer.name}</Button>}
                  <Button size="sm" variant="outline" onClick={() => openChat(item.id)}><MessageCircle /> Chat Giám khảo</Button>
                </li>)}</ul> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Danh sách chờ đang trống.</p>}
            </section>
          </div>
        )}

        {/* Trống */}
        {table?.status === "AVAILABLE" && !room?.is_challenge && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <div className={cn("flex size-16 items-center justify-center rounded-full", table.is_paused
              ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
              : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300")}>
              {table.is_paused ? <Pause className="size-8" /> : <Coffee className="size-8" />}
            </div>
            <p className="text-lg font-semibold">{table.is_paused ? "Đang tạm dừng tiếp nhận" : "Bàn đang trống"}</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              {table.is_paused ? "Điều phối viên không thể gán thí sinh vào bàn này cho đến khi bạn mở lại tiếp nhận." : "Điều phối viên sẽ gán thí sinh tiếp theo. Màn hình tự cập nhật, không cần tải lại."}
            </p>
          </div>
        )}

        {/* Được gán: chờ xác nhận */}
        {table?.status === "ASSIGNED" && candidate && (
          <div className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 text-center shadow-lg dark:bg-amber-950/60 sm:p-6">
            <BellRing className="mx-auto mb-3 size-10 animate-bounce text-amber-600" />
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Thí sinh được gán vào bàn</p>
            <p className="mt-2 break-words text-xl font-bold sm:text-2xl">{room?.is_challenge ? activeDebatePair.map((item) => item.full_name).join(" · ") : candidate.full_name}</p>
            <p className="mt-1 font-mono text-sm text-muted-foreground">{candidate.code}{candidate.student_number && ` · MSSV ${candidate.student_number}`}</p>
            <p className="mt-1 text-sm text-muted-foreground">{[candidate.department, specializationLabel(candidate.specialization), candidate.shift].filter(Boolean).join(" · ")}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              Đã gán <Elapsed since={table.assigned_at} /> trước
            </p>
            {room?.is_challenge && <div className="mt-4 grid gap-2 text-left sm:grid-cols-2">{activeDebatePair.map((item) => {
              const firstRound = evals.rows.find((evaluation) => evaluation.candidate_id === item.id);
              return <div key={item.id} className="rounded-xl border bg-background p-3 text-sm">
                <p className="font-semibold">Vị trí {item.debate_slot_number} · {item.full_name}</p>
                <p className="mt-1 text-xs text-muted-foreground">Nhận xét vòng 1 · {firstRound?.interviewer_name || "Giám khảo phỏng vấn"}</p>
                <p className="mt-1 whitespace-pre-wrap">{firstRound?.comment || "Chưa có nhận xét"}</p>
              </div>;
            })}</div>}
            <Button
              onClick={start}
              disabled={busy !== null || (!!room?.is_challenge && (!canDirectDebate || activeDebatePair.length < 1 || activeDebatePair.length > 2))}
              className="mt-6 h-16 w-full bg-emerald-600 text-lg font-semibold text-white hover:bg-emerald-700"
            >
              {busy === "start" ? <Loader2 className="size-6! animate-spin" /> : <CheckCircle2 className="size-6!" />}
              {room?.is_challenge ? `Bắt đầu Debate với ${activeDebatePair.length} thí sinh` : "Xác nhận thí sinh đã vào bàn"}
            </Button>
            {room?.is_challenge && activeDebatePair.length === 1 && <p className="mt-2 text-xs text-muted-foreground">GK 1 có thể bắt đầu ngay; GK 2 chỉ xem phiếu. Bạn cũng có thể chờ thêm thí sinh thứ hai trước khi bắt đầu.</p>}
            {(!room?.is_challenge || canDirectDebate) && <Button
              variant="ghost"
              onClick={() => setConfirm("return")}
              disabled={busy !== null}
              className="mt-3 h-11 w-full"
            >
              <Undo2 /> Nhầm thí sinh - Trả về phòng chờ
            </Button>}
          </div>
        )}

        {/* Đang phỏng vấn */}
        {table?.status === "INTERVIEWING" && candidate && (
          <div className="space-y-5">
            {room?.is_challenge && <section className="rounded-2xl border bg-card p-4">
              <h2 className="font-semibold">Ca Debate {candidate.debate_batch_number} · {activeDebatePair.length} thí sinh</h2>
              <p className="mt-1 text-xs text-muted-foreground">Chọn một thí sinh để xem phiếu vòng 1. {activeDebatePair.length === 1 ? "GK 1 nhận xét và chốt ca; GK 2 chỉ xem phiếu." : debateJudgeCount === 2 ? "GK 1 nhận xét vị trí 1, GK 2 nhận xét vị trí 2." : "GK 1 nhận xét cả hai vị trí."}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">{activeDebatePair.map((item) => {
                const firstRound = evals.rows.find((evaluation) => evaluation.candidate_id === item.id);
                const expectedPosition = activeDebatePair.length === 1 || debateJudgeCount === 1 ? 1 : item.debate_slot_number;
                const review = debateReviews.rows.find((entry) => entry.candidate_id === item.id && entry.table_id === tableId && entry.judge_position === expectedPosition);
                return <button key={item.id} type="button" onClick={() => setSelectedDebateCandidateId(item.id)}
                  aria-pressed={candidate.id === item.id}
                  className={cn("rounded-xl border p-3 text-left text-sm hover:border-primary", candidate.id === item.id && "border-primary bg-primary/5 ring-2 ring-primary/20")}>
                  <p className="font-semibold">Vị trí {item.debate_slot_number} · {item.full_name}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">{item.code} · {review ? "Đã xác nhận nhận xét" : `Chờ GK ${expectedPosition}`}</p>
                  <p className="mt-2 text-xs font-medium text-muted-foreground">Nhận xét vòng 1 · {firstRound?.interviewer_name || "Giám khảo phỏng vấn"}</p>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm">{firstRound?.comment || "Chưa có nhận xét"}</p>
                </button>;
              })}</div>
            </section>}
            <section className="rounded-2xl border bg-card p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="break-words text-lg font-bold sm:text-xl">{candidate.full_name}</p>
                  <p className="font-mono text-sm text-muted-foreground">{candidate.code}{candidate.student_number && ` · MSSV ${candidate.student_number}`}</p>
                </div>
                {cvUrl ? (
                  <a
                    href={cvUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full sm:w-auto sm:shrink-0")}
                  >
                    <ExternalLink /> Mở CV
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">Không có CV</span>
                )}
              </div>
              <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Ban ứng tuyển</dt>
                  <dd className="font-medium">{[candidate.department, specializationLabel(candidate.specialization)].filter(Boolean).join(" · ") || "—"}</dd>
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
                <section className="rounded-2xl border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30 sm:p-4">
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
              {room?.is_challenge && <section className="rounded-2xl border bg-card p-4">
                <h2 className="font-semibold">Nhận xét ca Debate</h2>
                <p className="mt-1 text-xs text-muted-foreground">GK 1 chốt ca sau khi mỗi thí sinh đã có nhận xét của giám khảo phụ trách.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">{activeDebatePair.map((item) => {
                  const expectedPosition = activeDebatePair.length === 1 || debateJudgeCount === 1 ? 1 : item.debate_slot_number;
                  const review = debateReviews.rows.find((entry) => entry.candidate_id === item.id && entry.table_id === tableId && entry.judge_position === expectedPosition);
                  return <div key={item.id} className="rounded-lg border p-3 text-sm">
                    <p className="font-semibold">{item.full_name} · GK {expectedPosition} · {review ? "Đã xác nhận" : "Chưa xác nhận"}</p>
                    {review && review.confirmed_by_id && review.confirmed_by_id !== review.judge_id && <p className="mt-1 text-xs font-medium text-amber-700">Admin xác nhận thay</p>}
                    {review && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{review.comment}</p>}
                  </div>;
                })}</div>
              </section>}
              {!room?.is_challenge && rubric.map((r, i) => (
                <div key={r.id} className="rounded-2xl border bg-card p-3 sm:p-4">
                  <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2">
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
              {!room?.is_challenge && rubric.length === 0 && (
                <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
                  Admin chưa cấu hình tiêu chí chấm. Bạn vẫn có thể ghi nhận xét và nộp.
                </p>
              )}

              {canScoreDebateCandidate ? <div className="rounded-2xl border bg-card p-4">
                  <label htmlFor="comment" className="mb-2 block font-semibold">
                   {room?.is_challenge ? `Nhận xét Debate · ${candidate.full_name}` : "Nhận xét"}
                </label>
                <Textarea
                  id="comment"
                  value={draft.comment}
                  onChange={(e) => update({ comment: e.target.value })}
                  placeholder="Điểm mạnh, điểm cần cải thiện, đề xuất…"
                  className="min-h-28 text-base"
                  maxLength={5000}
                />
              </div> : <p className="rounded-xl border bg-muted/40 p-4 text-sm text-muted-foreground">{activeDebatePair.length === 1 ? "Ca 1 thí sinh do Giám khảo 1 phụ trách." : `Thí sinh này do Giám khảo ${candidate.debate_slot_number} phụ trách.`} Bạn vẫn xem được phiếu vòng 1 và nhận xét khi giám khảo đó xác nhận.</p>}
              {candidate.department === "CM" && table.department === "CM" && !candidate.source_candidate_id && (
                <div className="rounded-2xl border bg-card p-4">
                  <p className="mb-1 font-semibold">Lượt phỏng vấn tiếp theo</p>
                  <p className="mb-3 text-sm text-muted-foreground">Có thể chọn Ban khác như bình thường, hoặc chọn lại Chuyên Môn với ngạch khác. Chưa chốt lịch thì Điều phối sẽ nhận lượt có dấu ? để sắp xếp sau.</p>
                  <DepartmentRadio name={`second-department-${candidate.id}`} value={draft.secondDepartment}
                    onChange={(value) => update({ secondDepartment: value, secondSpecialization: "", secondDate: "", secondTime: "" })} allowAll noneLabel="Không có lượt tiếp theo" />
                  {(draft.secondDepartment === "CM" || draft.secondDepartment === "TT") && <label className="mt-3 grid gap-1.5 text-sm font-medium">Ngạch {draft.secondDepartment === "CM" ? "Chuyên Môn" : "Truyền Thông"}
                    <select className="h-9 rounded-lg border border-input bg-background px-3" value={draft.secondSpecialization}
                      onChange={(event) => update({ secondSpecialization: event.target.value as SpecializationCode | "" })}>
                      <option value="">Chọn ngạch</option>
                      {(draft.secondDepartment === "CM" ? SPECIALIZATIONS_BY_DEPARTMENT.CM : SPECIALIZATIONS_BY_DEPARTMENT.TT)
                        .filter((item) => draft.secondDepartment !== "CM" || item.code !== candidate.specialization)
                        .map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
                    </select>
                  </label>}
                  {draft.secondDepartment && <div className="mt-4 space-y-2 border-t pt-4">
                    <p className="text-sm font-semibold">Lịch lượt tiếp theo <span className="font-normal text-muted-foreground">· để trống nếu chưa chốt</span></p>
                    {cand.rows.find((item) => item.source_candidate_id === candidate.id && item.department === draft.secondDepartment &&
                      (draft.secondDepartment !== "CM" || item.specialization === draft.secondSpecialization))?.shift && <p className="text-sm text-muted-foreground">Lịch đã nhập: {cand.rows.find((item) => item.source_candidate_id === candidate.id && item.department === draft.secondDepartment &&
                        (draft.secondDepartment !== "CM" || item.specialization === draft.secondSpecialization))?.shift}. Để trống sẽ giữ lịch này.</p>}
                    <ScheduleFields idPrefix="interviewer-followup" candidates={cand.rows} department={draft.secondDepartment}
                      date={draft.secondDate} time={draft.secondTime}
                      onDateChange={(secondDate) => update({ secondDate })} onTimeChange={(secondTime) => update({ secondTime })} />
                  </div>}
                </div>
              )}
            </section>
          </div>
        )}
        </div>
        {!room?.is_challenge && roundTwoOpen && completedAtTable.length > 0 && <aside className="min-w-0 rounded-xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/30 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div><h2 className="font-semibold">Theo dõi vòng 2</h2><p className="text-xs text-muted-foreground">Ứng viên đã chuyển khỏi bàn này</p></div>
            <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => setRoundTwoOpen(false)} aria-label="Đóng sidebar vòng 2"><PanelRightClose /></Button>
          </div>
          <ul className="space-y-2">
            {completedAtTable.map(({ evaluation, candidate: item }) => item && <li key={item.id} className="space-y-2 rounded-lg border bg-background p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><p className="break-words font-semibold">{item.full_name}</p><p className="text-xs text-muted-foreground">{evaluation.table_label} · {item.code}</p></div>
                <span className="shrink-0 rounded-full bg-violet-100 px-2 py-1 text-xs font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-200">
                  {item.challenge_status === "COMPLETED" ? "Hoàn tất" : item.challenge_status === "INTERVIEWING" ? "Đang Debate" : item.challenge_status === "ASSIGNED" ? `Đã vào vị trí ${item.debate_slot_number ?? "?"}` : item.department === "HCTC" ? item.debate_request_status === "PENDING" ? `Chờ ${tbl.rows.find((desk) => desk.id === item.challenge_table_id)?.name ?? "bàn Debate"} phản hồi` : "Danh sách chờ Debate" : "Đang thử thách"}
                </span>
              </div>
              {item.challenge_status !== "COMPLETED" && <p className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground"><Timer className="size-3" />Từ lúc chuyển vòng 2: <Elapsed since={item.challenge_started_at} /></p>}
              <div className="flex flex-wrap gap-2">
                {item.department === "HCTC" && <Button size="sm" variant="outline" onClick={() => openChat(item.id)}><MessageCircle /> Chat với Giám khảo Debate</Button>}
                {item.department === "VH" && item.challenge_status === "WAITING" && <>
                  <Button size="sm" onClick={() => setFinishExternal(item)} disabled={busy !== null}><CheckCircle2 /> Hoàn thành ca chấm</Button>
                  <Button size="sm" variant="outline" onClick={() => void continueVhReview(item)} disabled={busy !== null || table?.status !== "AVAILABLE"} title={table?.status !== "AVAILABLE" ? "Bàn cần trống trước khi tiếp tục chấm" : undefined}><Undo2 /> Tiếp tục chấm</Button>
                </>}
              </div>
            </li>)}
          </ul>
        </aside>}
      </main>

      {/* Thanh hành động cố định đáy màn hình khi đang phỏng vấn */}
      {table?.status === "INTERVIEWING" && candidate && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-2 px-2 py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:gap-3 sm:px-4 sm:py-3">
            {(!room?.is_challenge || canDirectDebate) && <Button
              variant="outline"
              className="h-12 shrink-0 px-2 sm:h-14 sm:px-3"
              onClick={() => setConfirm("return")}
              disabled={busy !== null || (!!room?.is_challenge && activeDebatePair.some((item) => item.challenge_status === "COMPLETED"))}
              title="Nhầm thí sinh - Trả về phòng chờ"
            >
              <Undo2 />
              <span className="hidden sm:inline">Nhầm thí sinh</span>
            </Button>}
            {!room?.is_challenge && <div className="hidden text-center sm:block">
              <p className="text-xs text-muted-foreground">Điểm TB</p>
              <p className="font-mono text-xl font-semibold tabular-nums">{avg == null ? "–" : avg.toFixed(2)}</p>
            </div>}
            {canScoreDebateCandidate && <Button
              className="h-12 min-w-0 flex-1 px-2 text-sm font-semibold leading-tight sm:h-14 sm:px-4 sm:text-base"
              onClick={() => setConfirm("submit")}
               disabled={busy !== null || missing.length > 0 || (!!room?.is_challenge && !draft.comment.trim())}
            >
              {busy === "submit" ? <Loader2 className="animate-spin" /> : <Send />}
               {missing.length > 0 ? `Còn ${missing.length} tiêu chí chưa chấm` : room?.is_challenge ? myDebateReview ? "Cập nhật nhận xét của tôi" : "Xác nhận nhận xét của tôi" : candidate.department === "VH" && room?.external_challenge ? "Xong phỏng vấn · Sang thử thách" : "Nộp đánh giá & Kết thúc"}
            </Button>}
            {room?.is_challenge && canDirectDebate && <Button
              className="h-12 shrink-0 sm:h-14" disabled={busy !== null || !allDebateJudgesConfirmed || myDebateReviewNeedsUpdate}
              onClick={() => void finalizeDebateCandidate()}>
              Chốt cả ca
            </Button>}
          </div>
        </div>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
               {confirm === "submit" ? room?.is_challenge ? "Xác nhận nhận xét của bạn?" : candidate?.department === "VH" && room?.external_challenge ? "Xong phỏng vấn và chuyển sang thử thách?" : "Nộp đánh giá và kết thúc?" : "Trả thí sinh về phòng chờ?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "submit"
                 ? room?.is_challenge
                   ? `Lưu nhận xét riêng của bạn cho ${candidate?.full_name}. GK 1 chốt ca sau khi ${activeDebatePair.length === 1 ? "thí sinh đã được nhận xét" : "hai thí sinh đã được nhận xét"}.`
                   : candidate?.department === "VH" && room?.external_challenge
                     ? `Lưu phiếu của ${candidate.full_name} và chuyển sang thử thách. Khi thử thách xong, bạn có thể hoàn thành ca chấm hoặc đưa thí sinh về bàn để chấm tiếp.`
                     : `Điểm TB ${avg == null ? "–" : avg.toFixed(2)}/10 cho ${candidate?.full_name}. Sau khi nộp, đồng hồ dừng và bàn được giải phóng. Không thể sửa lại từ màn hình này.`
                : `${candidate?.full_name ?? "Thí sinh"} sẽ quay về hàng chờ, điểm đang chấm dở sẽ bị xoá.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm === "submit" && candidate?.department === "HCTC" && !room?.is_challenge &&
            <label className="grid gap-1.5 text-sm font-medium">Chuyển sang bàn Debate
              <select className="h-10 rounded-lg border border-input bg-background px-3" value={debateTableId}
                onChange={(event) => setDebateTableId(event.target.value)}>
                <option value="">Chọn bàn Debate</option>
                {debateTables.map((desk) => <option key={desk.id} value={desk.id}>
                  {roomRows.rows.find((targetRoom) => targetRoom.id === desk.room_id)?.name} · {desk.name}
                </option>)}
              </select>
            </label>}
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">Quay lại</AlertDialogCancel>
            <AlertDialogAction
              className="h-11"
              variant={confirm === "submit" ? "default" : "destructive"}
              disabled={confirm === "submit" && candidate?.department === "HCTC" && !room?.is_challenge && !debateTableId}
              onClick={confirm === "submit" ? submit : returnToQueue}
            >
               {confirm === "submit" ? room?.is_challenge ? "Xác nhận nhận xét" : candidate?.department === "VH" && room?.external_challenge ? "Chuyển sang thử thách" : "Nộp & Kết thúc" : "Trả về phòng chờ"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={finishExternal !== null} onOpenChange={(open) => !open && setFinishExternal(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận hoàn thành toàn bộ phỏng vấn?</AlertDialogTitle>
            <AlertDialogDescription>
              {finishExternal?.full_name} đã hoàn thành thử thách vòng 2. Xác nhận sẽ chốt hồ sơ và chuyển trạng thái thí sinh sang hoàn tất.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">Huỷ</AlertDialogCancel>
            <AlertDialogAction className="h-11" onClick={() => finishExternal && void finishExternalChallenge(finishExternal)}>
              Ok, hoàn tất
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
