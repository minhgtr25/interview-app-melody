"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Check, Loader2, Pencil, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScheduleRequestDialog } from "@/components/schedule-request-dialog";
import { useServerNow } from "@/components/clock";
import { createClient } from "@/lib/supabase/client";
import { dayLabel, interviewDate, interviewDays, todayInVietnam } from "@/lib/interview-days";
import { errorMessage, normalizeText } from "@/lib/format";
import type { Candidate } from "@/lib/types";

export function AbsenceManagerDialog({ open, onClose, candidates, onChanged }: {
  open: boolean;
  onClose: () => void;
  candidates: Candidate[];
  onChanged: () => void;
}) {
  const [day, setDay] = useState("");
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<Candidate | null>(null);
  const [note, setNote] = useState("");
  const [schedule, setSchedule] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useServerNow(30_000);
  const days = useMemo(() => interviewDays(candidates), [candidates]);
  const absent = useMemo(() => candidates.filter((candidate) => candidate.status === "ABSENT" &&
    (!day || interviewDate(candidate) === day) &&
    (!query || normalizeText(`${candidate.full_name} ${candidate.code} ${candidate.student_number ?? ""}`).includes(normalizeText(query))))
    .sort((a, b) => (b.absent_at ?? "").localeCompare(a.absent_at ?? "")), [candidates, day, query]);

  async function updateNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit) return;
    setBusy(edit.id);
    const { error } = await createClient().rpc("update_absent_note", { p_candidate_id: edit.id, p_note: note });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    setEdit(null);
    onChanged();
    toast.success("Đã lưu ghi chú vắng mặt");
  }

  async function checkIn(candidate: Candidate) {
    setBusy(candidate.id);
    const { error } = await createClient().rpc("check_in_candidate", { p_candidate_id: candidate.id });
    setBusy(null);
    if (error) return toast.error(errorMessage(error));
    onChanged();
    toast.success(`Đã check-in lại ${candidate.full_name}`);
  }

  return <>
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Quản lý vắng mặt</DialogTitle>
          <DialogDescription>Xem, sửa ghi chú, check-in lại hoặc gửi yêu cầu đổi lịch cho Admin.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px]">
          <div className="relative"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Tìm tên, mã, MSSV" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <select className="h-10 rounded-lg border border-input bg-background px-3 text-sm" value={day} onChange={(event) => setDay(event.target.value)}>
            <option value="">Mọi ngày</option>
            {days.map((item) => <option key={item} value={item}>{dayLabel(item)}</option>)}
          </select>
        </div>
        <div className="min-h-0 overflow-y-auto">
          {absent.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">Không có trường hợp vắng mặt phù hợp.</p>}
          <ul className="space-y-2">
            {absent.map((candidate) => <li key={candidate.id} className="rounded-xl border p-3">
              <p className="font-semibold">{candidate.full_name} <span className="font-mono text-xs text-muted-foreground">{candidate.code}</span></p>
              <p className="text-xs text-muted-foreground">{candidate.department} · {candidate.shift || "Chưa có Ca"}</p>
              <p className="my-2 whitespace-pre-wrap text-sm">{candidate.absent_note || "Chưa có ghi chú"}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => { setEdit(candidate); setNote(candidate.absent_note ?? ""); }}><Pencil /> Sửa ghi chú</Button>
                <Button size="sm" variant="outline" onClick={() => void checkIn(candidate)}
                  disabled={busy === candidate.id || (!!interviewDate(candidate) && interviewDate(candidate) !== todayInVietnam(now))}
                  title={interviewDate(candidate) && interviewDate(candidate) !== todayInVietnam(now) ? "Gửi yêu cầu đổi lịch trước khi check-in" : undefined}><Check /> Check-in lại</Button>
                <Button size="sm" variant="outline" onClick={() => { onClose(); setSchedule(candidate); }}><CalendarClock /> Yêu cầu đổi lịch</Button>
              </div>
            </li>)}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={edit !== null} onOpenChange={(next) => !next && setEdit(null)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Sửa ghi chú · {edit?.full_name}</DialogTitle></DialogHeader>
        <form onSubmit={updateNote} className="grid gap-3">
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} className="min-h-28" />
          <DialogFooter><Button type="submit" disabled={busy !== null}>{busy && <Loader2 className="animate-spin" />} Lưu ghi chú</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <ScheduleRequestDialog candidate={schedule} candidates={candidates} onClose={() => setSchedule(null)} />
  </>;
}
