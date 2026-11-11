"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Check, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScheduleFields, isFutureInterviewSlot } from "@/components/schedule-fields";
import { useServerNow } from "@/components/clock";
import { useRealtimeRows } from "@/hooks/use-realtime-rows";
import { createClient } from "@/lib/supabase/client";
import { errorMessage, normalizeText } from "@/lib/format";
import { makeInterviewShift } from "@/lib/interview-days";
import type { Candidate, Profile, ScheduleRequest } from "@/lib/types";

export function RequestsManager({ initialRequests, candidates, profiles }: {
  initialRequests: ScheduleRequest[];
  candidates: Candidate[];
  profiles: Profile[];
}) {
  const requests = useRealtimeRows<ScheduleRequest>("schedule_requests", initialRequests);
  const liveCandidates = useRealtimeRows<Candidate>("candidates", candidates);
  const [filter, setFilter] = useState<ScheduleRequest["status"] | "">("PENDING");
  const [query, setQuery] = useState("");
  const [review, setReview] = useState<{ request: ScheduleRequest; approve: boolean } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [followup, setFollowup] = useState<Candidate | null>(null);
  const [followupDate, setFollowupDate] = useState("");
  const [followupTime, setFollowupTime] = useState("");
  const now = useServerNow(30_000);
  const candidateById = useMemo(() => new Map(liveCandidates.rows.map((item) => [item.id, item])), [liveCandidates.rows]);
  const profileById = useMemo(() => new Map(profiles.map((item) => [item.id, item])), [profiles]);
  const pending = requests.rows.filter((item) => item.status === "PENDING").length;
  const filtered = requests.rows.filter((item) => (!filter || item.status === filter) && (() => {
    if (!query) return true;
    const candidate = candidateById.get(item.candidate_id);
    const sender = item.requested_by ? profileById.get(item.requested_by) : null;
    return normalizeText(`${candidate?.full_name ?? ""} ${candidate?.code ?? ""} ${candidate?.student_number ?? ""} ${candidate?.phone ?? ""} ${candidate?.email ?? ""} ${candidate?.department ?? ""} ${item.reason} ${item.current_shift ?? ""} ${item.proposed_shift ?? ""} ${sender?.full_name ?? ""} ${sender?.email ?? ""}`)
      .includes(normalizeText(query));
  })()).sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "PENDING") return -1;
      if (b.status === "PENDING") return 1;
    }
    return b.created_at.localeCompare(a.created_at);
  });
  const statusLabel: Record<ScheduleRequest["status"] | "", string> = {
    "": "Tất cả trạng thái", PENDING: "Chờ xử lý", APPROVED: "Đã duyệt", REJECTED: "Từ chối", RESOLVED: "Đã xếp lịch",
  };

  async function decide() {
    if (!review) return;
    setBusy(true);
    const { error } = await createClient().rpc("decide_schedule_request", {
      p_request_id: review.request.id, p_approve: review.approve, p_note: note,
    });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    setReview(null);
    setNote("");
    void requests.refetch();
    toast.success(review.approve ? "Đã duyệt và cập nhật lịch phỏng vấn" : "Đã từ chối yêu cầu");
  }

  async function saveFollowup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!followup?.department || !isFutureInterviewSlot(followupDate, followupTime, now)) return;
    setBusy(true);
    const { error } = await createClient().rpc("set_followup_schedule", {
      p_candidate_id: followup.id,
      p_shift: makeInterviewShift(followupDate, followupTime, followup.department),
    });
    setBusy(false);
    if (error) return toast.error(errorMessage(error));
    setFollowup(null);
    void requests.refetch();
    toast.success("Đã xếp lịch Ban thứ hai");
  }

  return <section className="space-y-5">
    <div className="app-page-heading flex-wrap">
      <div><h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">Yêu cầu</h1><p className="mt-1 text-sm text-muted-foreground">{pending} yêu cầu đang chờ · Admin và Support IT cùng xử lý</p></div>
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="request-status-filter">Lọc trạng thái yêu cầu</label>
        <select id="request-status-filter" className="h-9 rounded-md border bg-background px-3 text-sm" value={filter}
          onChange={(event) => setFilter(event.target.value as ScheduleRequest["status"] | "")}>
          <option value="PENDING">Chờ xử lý ({pending})</option>
          <option value="">Tất cả trạng thái</option>
          {(["APPROVED", "REJECTED", "RESOLVED"] as const).map((status) => <option key={status} value={status}>{statusLabel[status]}</option>)}
        </select>
      </div>
    </div>
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-3 sm:flex-row">
      <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" className="pl-9 pr-9" placeholder="Tìm tên, MSSV, mã, SĐT, Ban, ca hoặc lý do" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Tìm yêu cầu" />
        {query && <Button type="button" variant="ghost" size="icon-xs" className="absolute right-2 top-1/2 -translate-y-1/2" aria-label="Xóa nội dung tìm kiếm" onClick={() => setQuery("")}><X /></Button>}
      </div>
      <span className="self-center text-xs text-muted-foreground" aria-live="polite">{filtered.length} yêu cầu</span>
    </div>
    <div className="grid gap-3">
      {filtered.map((item) => {
        const candidate = candidateById.get(item.candidate_id);
        const sender = item.requested_by ? profileById.get(item.requested_by) : null;
        return <article key={item.id} className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><CalendarClock className="size-4 text-primary" /><h2 className="font-semibold">{candidate?.full_name ?? "Thí sinh đã xóa"}</h2><span className="font-mono text-xs text-muted-foreground">{candidate?.code}</span></div>
              <p className="mt-1 text-sm">{item.kind === "RESCHEDULE" ? "Yêu cầu đổi lịch" : "Ban thứ hai chưa chốt lịch"} · {candidate?.department}</p>
              <p className="mt-1 text-sm text-muted-foreground">Ca hiện tại: {item.current_shift || candidate?.shift || "Chưa có"} → Đề xuất: <strong className="text-foreground">{item.proposed_shift || "Chờ Điều phối xếp"}</strong></p>
              {item.reason && <p className="mt-2 whitespace-pre-wrap text-sm">{item.reason}</p>}
              <p className="mt-2 text-xs text-muted-foreground">Gửi bởi {sender?.full_name || sender?.email || item.requested_role || "Hệ thống"} · {new Date(item.created_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</p>
            </div>
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{item.status === "PENDING" ? "Chờ xử lý" : item.status === "APPROVED" ? "Đã duyệt" : item.status === "REJECTED" ? "Từ chối" : "Đã xếp lịch"}</span>
          </div>
          {item.status === "PENDING" && item.kind === "RESCHEDULE" && <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
            <Button size="sm" onClick={() => { setReview({ request: item, approve: true }); setNote(""); }}><Check /> Duyệt đổi lịch</Button>
            <Button size="sm" variant="outline" onClick={() => { setReview({ request: item, approve: false }); setNote(""); }}><X /> Từ chối</Button>
          </div>}
          {item.status === "PENDING" && item.kind === "FOLLOWUP_UNDECIDED" && <div className="mt-3 border-t pt-3">
            {candidate && <Button size="sm" variant="outline" onClick={() => { setFollowup(candidate); setFollowupDate(""); setFollowupTime(""); }}><CalendarClock /> Xếp lịch Ban thứ hai</Button>}
            <p className="mt-2 text-xs text-muted-foreground">Điều phối cũng có thể xếp lịch tại lượt có dấu ? trong hàng chờ.</p>
          </div>}
          {item.review_note && <p className="mt-2 text-xs text-muted-foreground">Ghi chú xử lý: {item.review_note}</p>}
        </article>;
      })}
      {filtered.length === 0 && <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">Không có yêu cầu phù hợp.</p>}
    </div>
    <Dialog open={review !== null} onOpenChange={(open) => !open && !busy && setReview(null)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{review?.approve ? "Duyệt đổi lịch?" : "Từ chối yêu cầu?"}</DialogTitle>
          <DialogDescription>{review?.approve ? "Hệ thống sẽ cập nhật Ca và chuyển thí sinh sang ngày mới nếu cần." : "Ca hiện tại của thí sinh được giữ nguyên."}</DialogDescription>
        </DialogHeader>
        <Textarea placeholder="Ghi chú xử lý (không bắt buộc)" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} />
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setReview(null)}>Hủy</Button>
          <Button disabled={busy} onClick={() => void decide()}>{busy && <Loader2 className="animate-spin" />} {review?.approve ? "Duyệt" : "Từ chối"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={followup !== null} onOpenChange={(open) => !open && !busy && setFollowup(null)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Xếp lịch Ban thứ hai · {followup?.full_name}</DialogTitle></DialogHeader>
        <form onSubmit={saveFollowup} className="grid gap-4">
          <ScheduleFields idPrefix="admin-followup" candidates={liveCandidates.rows} department={followup?.department ?? ""}
            date={followupDate} time={followupTime} onDateChange={setFollowupDate} onTimeChange={setFollowupTime} />
          <Button type="submit" disabled={busy || !isFutureInterviewSlot(followupDate, followupTime, now)}>
            {busy && <Loader2 className="animate-spin" />} Lưu lịch phỏng vấn
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  </section>;
}
